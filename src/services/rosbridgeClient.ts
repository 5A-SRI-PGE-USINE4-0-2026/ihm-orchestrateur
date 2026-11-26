import type { CellSnapshot, ConnectionState, RosConfig } from '../types/cell';

export interface RosbridgeCallbacks {
  onStatusChange: (state: ConnectionState, detail: string) => void;
  onCellSnapshot: (snapshot: CellSnapshot) => void;
  onTelemetryPatch: (patch: Partial<CellSnapshot>, topic: string) => void;
  onTopicActivity: (topic: string, timestampMs: number) => void;
  onServerNotice?: (level: string, message: string) => void;
}

export interface ServiceCallResult {
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}

interface RosbridgeIncoming {
  op?: string;
  id?: string;
  topic?: string;
  service?: string;
  result?: boolean;
  values?: Record<string, unknown>;
  level?: string;
  msg?: Record<string, unknown> | string;
}

interface PendingServiceCall {
  resolve: (res: ServiceCallResult) => void;
  timer: number;
}

/**
 * Client rosbridge v2 bidirectionnel relié à `mfja_orchestrator` (`ws://localhost:9090`).
 *
 * - S'abonne aux topics `/mfja/*` et `/zone_{a,b}/*` pour la télémétrie temps réel.
 * - Transmet les appels de services (`call_service` -> `service_response`) vers la simulation ROS 2
 *   (`/usine40/supervision/*`, `/usine40/safety/*`, `/usine40/nl/*`, `/usine40/perception/*`).
 */
export class RosbridgeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private isStopped = true;
  private reqSeq = 0;
  private readonly pendingCalls = new Map<string, PendingServiceCall>();
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
    this.flushPendingCalls('Connexion WebSocket fermée.');
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

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public callService(
    service: string,
    args: Record<string, unknown> = {},
    timeoutMs = 7000
  ): Promise<ServiceCallResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        ok: false,
        message: `Pont WebSocket hors ligne (${this.config.rosbridgeUrl}).`,
      });
    }
    this.reqSeq += 1;
    const id = `ihm-svc-${Date.now()}-${this.reqSeq}`;

    return new Promise<ServiceCallResult>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pendingCalls.delete(id);
        resolve({ ok: false, message: `Délai dépassé sur le service ${service}.` });
      }, timeoutMs);

      this.pendingCalls.set(id, { resolve, timer });
      try {
        this.ws?.send(
          JSON.stringify({
            op: 'call_service',
            id,
            service,
            args,
          })
        );
      } catch (err) {
        window.clearTimeout(timer);
        this.pendingCalls.delete(id);
        resolve({ ok: false, message: `Échec d'envoi WebSocket : ${String(err)}` });
      }
    });
  }

  public startOrder(params: {
    quantity: number;
    enable_qc: boolean;
    enable_rework: boolean;
    inject_defect_on_index: number;
    scenario?: string;
    loop?: boolean;
  }): Promise<ServiceCallResult> {
    const svc = params.scenario
      ? '/mfja/orchestrator/start_order'
      : '/usine40/supervision/start_order';
    return this.callService(svc, params);
  }

  public setPause(paused: boolean): Promise<ServiceCallResult> {
    return this.callService('/usine40/supervision/pause', { paused });
  }

  public resetCell(): Promise<ServiceCallResult> {
    return this.callService('/usine40/supervision/reset', {});
  }

  public setEstop(active: boolean): Promise<ServiceCallResult> {
    return this.callService('/usine40/safety/estop', { active });
  }

  public setHumanPresence(present: boolean): Promise<ServiceCallResult> {
    return this.callService('/usine40/safety/set_human_presence', { present });
  }

  public parseNaturalLanguage(
    instruction: string,
    autoConfirm = false
  ): Promise<ServiceCallResult> {
    return this.callService('/usine40/nl/parse', {
      instruction,
      auto_confirm: autoConfirm,
    });
  }

  public approveNaturalLanguage(
    proposalId: string,
    approve: boolean
  ): Promise<ServiceCallResult> {
    return this.callService('/usine40/nl/approve', {
      proposal_id: proposalId,
      approve,
    });
  }

  private flushPendingCalls(reason: string): void {
    this.pendingCalls.forEach((entry) => {
      window.clearTimeout(entry.timer);
      entry.resolve({ ok: false, message: reason });
    });
    this.pendingCalls.clear();
  }

  private openSocket(): void {
    if (this.isStopped) return;

    this.callbacks.onStatusChange(
      'connecting',
      `Connexion bidirectionnelle vers ${this.config.rosbridgeUrl}`
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
          `Connecté à l'orchestrateur ROS 2 (${this.config.rosbridgeUrl})`
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
        this.flushPendingCalls('Connexion WebSocket interrompue.');
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
          throttle_rate: 40,
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

    if (parsed.op === 'service_response') {
      const id = parsed.id ?? '';
      const pending = this.pendingCalls.get(id);
      if (pending) {
        window.clearTimeout(pending.timer);
        this.pendingCalls.delete(id);
        const vals = (parsed.values ?? {}) as Record<string, unknown>;
        pending.resolve({
          ...vals,
          ok: Boolean(parsed.result ?? vals.ok ?? true),
          message: typeof vals.message === 'string' ? vals.message : undefined,
        });
      }
      return;
    }

    if (parsed.op === 'status' && typeof parsed.msg === 'string') {
      this.callbacks.onServerNotice?.(parsed.level ?? 'info', parsed.msg);
      return;
    }

    if (parsed.op !== 'publish' || !parsed.topic || !parsed.msg || typeof parsed.msg !== 'object') {
      return;
    }
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

export const ReadOnlyRosbridgeClient = RosbridgeClient;
