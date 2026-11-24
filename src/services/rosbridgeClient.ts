import type { CellSnapshot, ConnectionState, RosConfig } from '../types/cell';

export interface RosbridgeCallbacks {
  onStatusChange: (state: ConnectionState, detail: string) => void;
  onCellSnapshot: (snapshot: CellSnapshot) => void;
  onTelemetryPatch: (patch: Partial<CellSnapshot>, topic: string) => void;
  onTopicActivity: (topic: string, timestampMs: number) => void;
}

interface RosbridgeIncoming {
  op?: string;
  topic?: string;
  msg?: Record<string, unknown>;
}

/**
 * Client rosbridge v2 strictement en LECTURE SEULE.
 *
 * Par conception (exigence projet : l'orchestrateur L1 est seul habilité à commander),
 * cette classe n'implémente aucune opération `publish`, `call_service` ou `send_action_goal`.
 * Seule l'opération `subscribe` / `unsubscribe` est transmise au serveur rosbridge.
 */
export class ReadOnlyRosbridgeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private isStopped = true;
  private readonly config: RosConfig;
  private readonly callbacks: RosbridgeCallbacks;

  constructor(config: RosConfig, callbacks: RosbridgeCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  public connect(): void {
    this.isStopped = false;
    this.openSocket();
  }

  public disconnect(): void {
    this.isStopped = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          Object.values(this.config.topics).forEach((topic) => {
            this.ws?.send(JSON.stringify({ op: 'unsubscribe', topic }));
          });
        }
        this.ws.close();
      } catch {
        // Ignore close errors during teardown
      }
      this.ws = null;
    }
    this.callbacks.onStatusChange('disconnected', 'Déconnecté du pont orchestrateur');
  }

  private openSocket(): void {
    if (this.isStopped) return;

    this.callbacks.onStatusChange(
      'connecting',
      `Connexion en lecture seule vers ${this.config.rosbridgeUrl}`
    );

    try {
      const socket = new WebSocket(this.config.rosbridgeUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (this.isStopped) {
          socket.close();
          return;
        }
        this.callbacks.onStatusChange(
          'connected',
          `Connecté à l'orchestrateur (${this.config.rosbridgeUrl})`
        );
        this.subscribeAll(socket);
      };

      socket.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      socket.onerror = () => {
        this.callbacks.onStatusChange(
          'error',
          `Orchestrateur injoignable sur ${this.config.rosbridgeUrl}`
        );
      };

      socket.onclose = () => {
        this.ws = null;
        if (!this.isStopped) {
          this.callbacks.onStatusChange(
            'disconnected',
            `Orchestrateur hors ligne — reconnexion automatique (${Math.round(
              this.config.reconnectIntervalMs / 1000
            )} s)`
          );
          this.reconnectTimer = window.setTimeout(
            () => this.openSocket(),
            this.config.reconnectIntervalMs
          );
        }
      };
    } catch {
      this.callbacks.onStatusChange(
        'error',
        `Adresse WebSocket invalide : ${this.config.rosbridgeUrl}`
      );
    }
  }

  private subscribeAll(socket: WebSocket): void {
    const topicList = Object.values(this.config.topics);
    topicList.forEach((topic) => {
      socket.send(
        JSON.stringify({
          op: 'subscribe',
          topic,
          throttle_rate: 80,
        })
      );
    });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let parsed: RosbridgeIncoming;
    try {
      parsed = JSON.parse(raw) as RosbridgeIncoming;
    } catch {
      return;
    }

    if (parsed.op !== 'publish' || !parsed.topic || !parsed.msg) return;
    const topic = parsed.topic;
    const msg = parsed.msg;
    this.callbacks.onTopicActivity(topic, Date.now());

    let payload: Record<string, unknown> = msg;
    if (typeof msg.data === 'string') {
      try {
        const inner = JSON.parse(msg.data) as Record<string, unknown>;
        if (inner && typeof inner === 'object') {
          payload = inner;
        }
      } catch {
        // Payload non JSON ignoré
      }
    }

    if (topic === this.config.topics.cellState && payload.yaskawaA && payload.montracA) {
      this.callbacks.onCellSnapshot(payload as unknown as CellSnapshot);
      return;
    }

    if (topic === this.config.topics.safetyStatus && typeof payload.summary === 'string') {
      this.callbacks.onTelemetryPatch(
        {
          safety: {
            status:
              payload.status === 'estop_triggered' || payload.status === 'warning'
                ? payload.status
                : 'nominal',
            hardwareEstopEngaged: Boolean(payload.hardwareEstopEngaged),
            watchdogFault: Boolean(payload.watchdogFault),
            summary: String(payload.summary),
            operatorGuidance: String(
              payload.operatorGuidance ??
                'Se référer aux procédures de sécurité du plateau Salle 315.'
            ),
            lastCheckTimestamp: new Date().toLocaleTimeString('fr-FR'),
          },
        },
        topic
      );
    }
  }
}
