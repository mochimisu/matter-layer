import WebSocket from "ws";
import { normalizeValue } from "../../runtime/sources";
import type { ProviderAdapter, Runtime, SourceBinding, SourceUpdate } from "../../runtime/types";

type HaRuntime = Runtime & {
  sources?: Map<string, { binding: SourceBinding }>;
  notifyProviderChanged?: (provider: "ha") => void;
};

type PendingCall = {
  resolve: (message: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export class HomeAssistantProvider implements ProviderAdapter {
  readonly name = "ha" as const;
  private runtime?: HaRuntime;
  private ws?: WebSocket;
  private connected = false;
  private authenticated = false;
  private sourceBindings: SourceBinding[] = [];
  private sourceByEntity = new Map<string, SourceBinding[]>();
  private entityBySelector = new Map<string, string>();
  private nextMessageId = 1;
  private pending = new Map<number, PendingCall>();
  private reconnectTimer?: NodeJS.Timeout;
  private lastMessageAt?: number;
  private error?: string;

  constructor(
    private readonly options: {
      url: string;
      token?: string;
      enabled?: boolean;
    },
  ) {}

  async start(runtime: HaRuntime) {
    this.runtime = runtime;
    this.sourceBindings = [...(runtime.sources?.values() ?? [])]
      .map((source) => source.binding)
      .filter((binding) => binding.provider === "ha" && binding.path);
    if (this.options.enabled === false || this.sourceBindings.length === 0) {
      return;
    }
    if (!this.options.token) {
      this.error = "MATTER_LAYER_HA_TOKEN is not set";
      this.runtime?.notifyProviderChanged?.(this.name);
      return;
    }
    await this.connect();
  }

  stop() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Home Assistant provider stopped"));
      this.pending.delete(id);
    }
    this.ws?.close();
    this.ws = undefined;
    this.connected = false;
    this.authenticated = false;
  }

  snapshot() {
    return {
      enabled: this.options.enabled !== false,
      connected: this.connected,
      authenticated: this.authenticated,
      sourceCount: this.sourceBindings.length,
      entityCount: this.sourceByEntity.size,
      lastMessageAt: this.lastMessageAt,
      error: this.error,
      sources: this.sourceBindings.map((binding) => ({
        source: binding.source,
        selector: binding.path,
        entityId: binding.path ? this.entityBySelector.get(binding.path) : undefined,
      })),
    };
  }

  private async connect() {
    clearTimeout(this.reconnectTimer);
    this.error = undefined;
    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      ws.on("open", () => {
        this.connected = true;
        this.runtime?.notifyProviderChanged?.(this.name);
      });
      ws.on("message", (buffer) => {
        void this.handleMessage(JSON.parse(String(buffer))).then((ready) => {
          if (ready) settle();
        }, (error) => {
          this.error = error instanceof Error ? error.message : String(error);
          this.runtime?.notifyProviderChanged?.(this.name);
          settle();
        });
      });
      ws.on("close", () => {
        this.connected = false;
        this.authenticated = false;
        this.runtime?.notifyProviderChanged?.(this.name);
        this.scheduleReconnect();
        settle();
      });
      ws.on("error", (error) => {
        this.error = error.message;
        this.runtime?.notifyProviderChanged?.(this.name);
        settle();
      });
    });
  }

  private async handleMessage(message: any) {
    this.lastMessageAt = Date.now();
    if (message.type === "auth_required") {
      this.ws?.send(JSON.stringify({ type: "auth", access_token: this.options.token }));
      return false;
    }
    if (message.type === "auth_ok") {
      this.authenticated = true;
      this.runtime?.notifyProviderChanged?.(this.name);
      await this.initializeSubscriptions();
      return true;
    }
    if (message.type === "auth_invalid") {
      throw new Error(message.message ?? "Home Assistant auth failed");
    }
    if (message.type === "event" && message.event?.event_type === "state_changed") {
      this.handleStateChanged(message.event.data);
      return false;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.success === false) {
        pending.reject(new Error(JSON.stringify(message.error ?? "Home Assistant call failed")));
      } else {
        pending.resolve(message);
      }
    }
    return false;
  }

  private async initializeSubscriptions() {
    const registry = await this.call("config/entity_registry/list");
    const entityByUniqueId = new Map<string, string>();
    for (const entity of registry.result ?? []) {
      if (entity?.unique_id && entity?.entity_id) {
        entityByUniqueId.set(String(entity.unique_id), String(entity.entity_id));
      }
    }

    this.sourceByEntity.clear();
    this.entityBySelector.clear();
    for (const binding of this.sourceBindings) {
      const selector = binding.path!;
      const entityId = selector.startsWith("unique_id:")
        ? entityByUniqueId.get(selector.slice("unique_id:".length))
        : selector;
      if (!entityId) {
        this.error = `HA selector did not resolve: ${selector}`;
        continue;
      }
      this.entityBySelector.set(selector, entityId);
      const bindings = this.sourceByEntity.get(entityId) ?? [];
      bindings.push(binding);
      this.sourceByEntity.set(entityId, bindings);
    }

    const states = await this.call("get_states");
    for (const state of states.result ?? []) {
      if (state?.entity_id && this.sourceByEntity.has(String(state.entity_id))) {
        this.emitState(String(state.entity_id), state, { markUpdated: false });
      }
    }
    await this.call("subscribe_events", { event_type: "state_changed" });
    this.runtime?.notifyProviderChanged?.(this.name);
  }

  private handleStateChanged(data: any) {
    const entityId = String(data?.entity_id ?? "");
    if (!entityId || !this.sourceByEntity.has(entityId)) return;
    this.emitState(entityId, data.new_state);
  }

  private emitState(entityId: string, state: any, options: { markUpdated?: boolean } = {}) {
    const bindings = this.sourceByEntity.get(entityId) ?? [];
    const observedAt = Date.parse(state?.last_changed ?? state?.last_updated ?? "") || Date.now();
    for (const binding of bindings) {
      this.runtime?.updateSource({
        source: binding.source,
        value: normalizeHaValue(binding, state?.state),
        provider: this.name,
        observedAt,
        markUpdated: options.markUpdated,
      } satisfies SourceUpdate);
    }
  }

  private call(type: string, body: Record<string, unknown> = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Home Assistant websocket is not open"));
    }
    const id = this.nextMessageId++;
    this.ws.send(JSON.stringify({ id, type, ...body }));
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Home Assistant call timed out: ${type}`));
      }, 10_000);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  private scheduleReconnect() {
    if (this.options.enabled === false || !this.options.token || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, 5_000);
    this.reconnectTimer.unref?.();
  }
}

function normalizeHaValue(binding: SourceBinding, raw: unknown) {
  if (raw === "unknown" || raw === "unavailable" || raw == null) {
    return undefined;
  }
  if (binding.encoding === "ha-number" && typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return normalizeValue(binding, raw);
}
