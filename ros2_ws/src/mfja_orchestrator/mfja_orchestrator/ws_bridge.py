"""Serveur WebSocket rosbridge v2 strictement en LECTURE SEULE (stdlib Python uniquement).

Implémente RFC 6455 + protocole JSON rosbridge v2 (`subscribe` / `unsubscribe` / `publish` sortant).
Toute tentative d'un client WebSocket d'émettre `publish`, `call_service` ou `send_action_goal`
est explicitement refusée afin de garantir l'exclusivité de commande de l'orchestrateur L1.
"""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass, field
import hashlib
import json
import struct
import threading
from typing import Any


_WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


@dataclass(eq=False)
class _WsClient:
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    subscriptions: set[str] = field(default_factory=set)
    peer: str = ""


def _encode_ws_frame(payload_text: str, opcode: int = 0x1) -> bytes:
    payload = payload_text.encode("utf-8")
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + payload


async def _read_ws_frame(reader: asyncio.StreamReader) -> tuple[int, bytes] | None:
    try:
        first_two = await reader.readexactly(2)
    except (asyncio.IncompleteReadError, ConnectionResetError, OSError):
        return None

    opcode = first_two[0] & 0x0F
    masked = bool(first_two[1] & 0x80)
    length = first_two[1] & 0x7F

    if length == 126:
        ext = await reader.readexactly(2)
        length = struct.unpack("!H", ext)[0]
    elif length == 127:
        ext = await reader.readexactly(8)
        length = struct.unpack("!Q", ext)[0]

    mask_key = await reader.readexactly(4) if masked else b""
    payload = bytearray(await reader.readexactly(length)) if length > 0 else bytearray()

    if masked and mask_key:
        for i in range(length):
            payload[i] ^= mask_key[i % 4]

    return opcode, bytes(payload)


class ReadOnlyRosbridgeServer:
    """Pont WebSocket rosbridge v2 en lecture seule exécuté sur un thread asyncio dédié."""

    def __init__(self, host: str = "0.0.0.0", port: int = 9090) -> None:
        self.host = host
        self.port = port
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._clients: set[_WsClient] = set()
        self._latest_by_topic: dict[str, dict[str, Any]] = {}
        self._ready = threading.Event()
        self._server: asyncio.AbstractServer | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run_loop, name="rosbridge-ws", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=3.0)

    def stop(self) -> None:
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self._shutdown(), self._loop).result(timeout=2.0)
            self._loop.call_soon_threadsafe(self._loop.stop)

    def client_count(self) -> int:
        return len(self._clients)

    def broadcast_topic(self, topic: str, msg: dict[str, Any]) -> None:
        """Diffuse un message rosbridge `publish` aux clients abonnés à `topic`."""
        self._latest_by_topic[topic] = msg
        if not self._loop or not self._loop.is_running():
            return
        asyncio.run_coroutine_threadsafe(self._send_to_subscribers(topic, msg), self._loop)

    def _run_loop(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._start_server())
        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            self._loop.close()

    async def _start_server(self) -> None:
        self._server = await asyncio.start_server(self._handle_connection, self.host, self.port)

    async def _shutdown(self) -> None:
        for client in list(self._clients):
            try:
                client.writer.close()
            except OSError:
                pass
        self._clients.clear()
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        peer_info = writer.get_extra_info("peername")
        peer = f"{peer_info[0]}:{peer_info[1]}" if peer_info else "unknown"

        try:
            raw_headers = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5.0)
        except Exception:
            writer.close()
            return

        headers: dict[str, str] = {}
        for line in raw_headers.decode("utf-8", errors="ignore").split("\r\n")[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        ws_key = headers.get("sec-websocket-key")
        if not ws_key:
            writer.write(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            await writer.drain()
            writer.close()
            return

        accept_val = base64.b64encode(
            hashlib.sha1((ws_key + _WS_MAGIC_GUID).encode("utf-8")).digest()
        ).decode("ascii")

        handshake = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_val}\r\n\r\n"
        )
        writer.write(handshake.encode("ascii"))
        await writer.drain()

        client = _WsClient(reader=reader, writer=writer, peer=peer)
        self._clients.add(client)

        try:
            while True:
                frame = await _read_ws_frame(reader)
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 0x8:  # Close
                    break
                if opcode == 0x9:  # Ping -> Pong
                    writer.write(_encode_ws_frame(payload.decode("utf-8", errors="ignore"), opcode=0xA))
                    await writer.drain()
                    continue
                if opcode == 0x1:  # Text JSON rosbridge frame
                    await self._handle_rosbridge_message(client, payload.decode("utf-8", errors="ignore"))
        finally:
            self._clients.discard(client)
            try:
                writer.close()
                await writer.wait_closed()
            except OSError:
                pass

    async def _handle_rosbridge_message(self, client: _WsClient, text: str) -> None:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return

        op = data.get("op")
        topic = data.get("topic")

        if op == "subscribe" and isinstance(topic, str):
            client.subscriptions.add(topic)
            # Pousse immédiatement le dernier état connu au nouvel abonné
            if topic in self._latest_by_topic:
                frame = _encode_ws_frame(
                    json.dumps({"op": "publish", "topic": topic, "msg": self._latest_by_topic[topic]})
                )
                client.writer.write(frame)
                await client.writer.drain()
        elif op == "unsubscribe" and isinstance(topic, str):
            client.subscriptions.discard(topic)
        elif op in ("publish", "call_service", "send_action_goal"):
            # Refus strict côté serveur : l'IHM ne peut jamais commander l'orchestrateur
            notice = json.dumps(
                {
                    "op": "status",
                    "level": "error",
                    "msg": f"Opération '{op}' refusée : le pont IHM est strictement en lecture seule.",
                }
            )
            client.writer.write(_encode_ws_frame(notice))
            await client.writer.drain()

    async def _send_to_subscribers(self, topic: str, msg: dict[str, Any]) -> None:
        if not self._clients:
            return
        frame = _encode_ws_frame(json.dumps({"op": "publish", "topic": topic, "msg": msg}))
        dead: list[_WsClient] = []
        for client in list(self._clients):
            if topic not in client.subscriptions:
                continue
            try:
                client.writer.write(frame)
                await client.writer.drain()
            except OSError:
                dead.append(client)
        for d in dead:
            self._clients.discard(d)
