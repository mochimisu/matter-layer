import WebSocket from "ws";
import { matterLabelForKey, matterMacForKey, matterUniqueIdForKey, type MatterBinding } from "../../config/bindings";
import { normalizeValue } from "../../runtime/sources";
import type {
  CommandResult,
  DesiredCommand,
  MatterLogEntry,
  ProviderAdapter,
  Runtime,
  SourceBinding,
  SourceUpdate,
} from "../../runtime/types";

type MatterRuntimeLogEntry = Omit<MatterLogEntry, "id">;

export class MatterProvider implements ProviderAdapter {
  readonly name = "matter" as const;
  private runtime?: Runtime & {
    enqueueApply?: (target: string) => void;
    notifyProviderChanged?: (provider: "matter") => void;
    logMatter?: (entry: MatterRuntimeLogEntry) => void;
  };
  private sources: SourceBinding[] = [];
  private sourceRefs = new Map<string, { updated: () => number | undefined }>();
  private targets = new Map<string, { target: string; capabilities: Record<string, any> }>();
  private ws?: WebSocket;
  private connected = false;
  private listenRefreshTimer?: NodeJS.Timeout;
  private nodeCount = 0;
  private lastMessageAt?: number;
  private nodeByKey = new Map<string, number>();
  private resolvedTargets = new Set<string>();
  private labelByNode = new Map<number, string>();
  private uniqueIdByNode = new Map<number, string>();
  private macByNode = new Map<number, string>();
  private availableByNode = new Map<number, boolean>();
  private offlineSinceByNode = new Map<number, number>();
  private rssiByNode = new Map<number, number>();
  private lastProbeByTarget = new Map<string, number>();
  private lastProbeByNode = new Map<number, number>();
  private lastPingByNode = new Map<number, number>();
  private lastSourceProbeByNode = new Map<number, number>();
  private probingTargets = new Set<string>();
  private staleProbeTimer?: NodeJS.Timeout;
  private staleProbeRunning = false;
  private staleProbeStartedAt = Date.now();
  private remoteKeepaliveTimer?: NodeJS.Timeout;
  private remoteKeepaliveRunning = false;
  private remoteKeepaliveCursor = 0;
  private startupAttributeSyncRunning = false;
  private recentInitialPressByEndpoint = new Map<string, number>();
  private sourceByNodePath = new Map<string, SourceBinding[]>();
  private nextMessageId = 0;
  private pending = new Map<
    string,
    {
      resolve: (message: any) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly options: {
      url: string;
      dryRun?: boolean;
      enabled?: boolean;
      remoteKeepaliveEnabled?: boolean;
      bindings?: Record<string, MatterBinding>;
    },
  ) {}

  async start(
    runtime: Runtime & {
      sources?: Map<string, { binding: SourceBinding; updated: () => number | undefined }>;
      targets?: Map<string, any>;
      enqueueApply?: (target: string) => void;
      notifyProviderChanged?: (provider: "matter") => void;
    },
  ) {
    this.runtime = runtime;
    if (runtime.sources) {
      this.sourceRefs = new Map(
        [...runtime.sources.values()].map((source) => [
          source.binding.source,
          { updated: () => source.updated() },
        ]),
      );
      this.sources = [...runtime.sources.values()].map((source) => source.binding).filter((source) => source.provider === "matter");
    }
    if (runtime.targets) {
      this.targets = new Map(
        [...runtime.targets.entries()].filter(([, binding]) => binding.provider === "matter").map(([target, binding]) => [target, binding]),
      );
    }
    if (this.options.enabled === false) {
      return;
    }
    const startup = this.connect();
    this.startStaleProbeLoop();
    this.startRemoteKeepaliveLoop();
    await startup;
  }

  async apply(command: DesiredCommand): Promise<CommandResult> {
    if (this.options.dryRun) {
      return {
        command,
        provider: this.name,
        dryRun: true,
        ok: true,
        appliedAt: Date.now(),
      };
    }
    const messages = this.translateCommand(command);
    if (messages.length === 0) {
      return {
        command,
        provider: this.name,
        dryRun: false,
        ok: false,
        error: `No Matter command mapping for ${command.target}`,
        appliedAt: Date.now(),
      };
    }
    try {
      for (const message of messages) {
        await this.send(message);
      }
    } catch (error) {
      return {
        command,
        provider: this.name,
        dryRun: false,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        appliedAt: Date.now(),
      };
    }
    return {
      command,
      provider: this.name,
      dryRun: false,
      ok: true,
      appliedAt: Date.now(),
    };
  }

  async pingTarget(target: string) {
    if (this.options.dryRun) {
      return { ok: true, dryRun: true, target };
    }
    const nodeId = this.nodeIdForTarget(target);
    this.recordProbe(target);
    this.lastProbeByNode.set(nodeId, Date.now());
    this.lastPingByNode.set(nodeId, Date.now());
    const started = Date.now();
    try {
      const response = await this.send({ command: "ping_node", args: { node_id: nodeId } }, 15_000);
      const result = (response as any).result;
      const ok = pingResultIsReachable(result);
      const elapsedMs = Date.now() - started;
      this.setNodeAvailability(nodeId, ok);
      this.runtime?.logMatter?.({
        at: Date.now(),
        direction: "sent",
        kind: "ping",
        subject: target,
        key: target,
        nodeId,
        value: result,
        ok,
        elapsedMs,
        ...(ok ? {} : { error: "Matter ping failed" }),
      });
      return {
        ok,
        dryRun: false,
        target,
        nodeId,
        elapsedMs,
        result,
        ...(ok ? {} : { error: "Matter ping failed" }),
      };
    } catch (error) {
      this.setNodeAvailability(nodeId, false);
      this.runtime?.logMatter?.({
        at: Date.now(),
        direction: "sent",
        kind: "ping",
        subject: target,
        key: target,
        nodeId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - started,
      });
      throw error;
    }
  }

  async probeTarget(target: string) {
    if (this.options.dryRun) {
      return { ok: true, dryRun: true, target };
    }
    const nodeId = this.nodeIdForTarget(target);
    this.recordProbe(target);
    this.lastProbeByNode.set(nodeId, Date.now());
    this.lastSourceProbeByNode.set(nodeId, Date.now());
    const started = Date.now();
    const paths = this.probePathsForTarget(target, nodeId);
    const reads: Array<{ path: string; ok: boolean; value?: unknown; error?: string; elapsedMs: number }> = [];
    let ok = false;

    for (const path of paths) {
      const readStarted = Date.now();
      try {
        const response = await this.send(
          {
            command: "read_attribute",
            args: {
              node_id: nodeId,
              attribute_path: path,
            },
          },
          5_000,
        );
        const value = this.valueFromReadResponse(response, path);
        this.emitNodePath(nodeId, path, value);
        reads.push({ path, ok: true, value, elapsedMs: Date.now() - readStarted });
        ok = true;
      } catch (error) {
        reads.push({
          path,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - readStarted,
        });
      }
    }

    this.setNodeAvailability(nodeId, ok);
    if (ok) {
      const elapsedMs = Date.now() - started;
      this.runtime?.logMatter?.({
        at: Date.now(),
        direction: "sent",
        kind: "probe",
        subject: target,
        key: target,
        nodeId,
        value: reads,
        ok: true,
        elapsedMs,
      });
      return { ok: true, dryRun: false, target, nodeId, elapsedMs, reads };
    }
    const firstError = reads.find((read) => !read.ok)?.error ?? "Matter probe failed";
    this.runtime?.logMatter?.({
      at: Date.now(),
      direction: "sent",
      kind: "probe",
      subject: target,
      key: target,
      nodeId,
      value: reads,
      ok: false,
      error: firstError,
      elapsedMs: Date.now() - started,
    });
    throw new Error(firstError);
  }

  async refreshNodes() {
    if (this.options.dryRun) {
      return { ok: true, dryRun: true, nodeCount: 0 };
    }
    const response = await this.send(
      {
        command: "start_listening",
        args: {},
      },
      15_000,
    );
    const nodes = Array.isArray((response as any).result) ? (response as any).result : [];
    this.ingestNodes(nodes, { emitSourceValues: false });
    return { ok: true, dryRun: false, nodeCount: nodes.length };
  }

  snapshot() {
    return {
      enabled: this.options.enabled !== false,
      connected: this.connected,
      url: this.options.url,
      nodeCount: this.nodeCount,
      lastMessageAt: this.lastMessageAt,
      remoteKeepaliveEnabled: this.remoteKeepaliveEnabled(),
      resolved: [...this.nodeByKey.entries()].map(([key, nodeId]) => ({
        key,
        nodeId,
        label: this.labelByNode.get(nodeId),
        uniqueId: this.uniqueIdByNode.get(nodeId),
        mac: this.macByNode.get(nodeId),
        available: this.availableByNode.get(nodeId),
        offlineSince: this.offlineSinceByNode.get(nodeId),
        rssi: this.rssiByNode.get(nodeId),
        lastProbeAt: this.lastProbeByTarget.get(key),
      })),
      unresolvedSources: this.sources
        .filter((source) => this.options.enabled !== false && source.provider === "matter" && !this.nodeByKey.has(source.key))
        .map((source) => source.source),
      unresolvedTargets: this.options.enabled === false ? [] : [...this.targets.keys()].filter((target) => !this.nodeByKey.has(target)),
    };
  }

  setRemoteKeepaliveEnabled(enabled: boolean) {
    this.options.remoteKeepaliveEnabled = enabled;
    if (!enabled && this.remoteKeepaliveTimer) {
      clearInterval(this.remoteKeepaliveTimer);
      this.remoteKeepaliveTimer = undefined;
    }
    if (enabled) {
      this.startRemoteKeepaliveLoop();
    }
    this.runtime?.notifyProviderChanged?.(this.name);
  }

  private remoteKeepaliveEnabled() {
    return this.options.remoteKeepaliveEnabled !== false;
  }

  private connect() {
    const ws = new WebSocket(this.options.url, { maxPayload: 1024 * 1024 * 32 });
    this.ws = ws;
    let startupSettled = false;
    let startupTimeout: NodeJS.Timeout | undefined;
    let settleStartup = () => {};
    const startupReady = new Promise<void>((resolve) => {
      settleStartup = () => {
        if (startupSettled) {
          return;
        }
        startupSettled = true;
        if (startupTimeout) {
          clearTimeout(startupTimeout);
          startupTimeout = undefined;
        }
        resolve();
      };
    });
    const timeoutMs = Math.max(1000, Number(process.env.MATTER_STARTUP_SYNC_TIMEOUT_SEC ?? "30") * 1000);
    startupTimeout = setTimeout(settleStartup, timeoutMs);
    startupTimeout.unref?.();

    ws.on("open", () => {
      this.connected = true;
      this.runtime?.notifyProviderChanged?.(this.name);
      ws.send(JSON.stringify({ message_id: "matter-layer-start", command: "start_listening", args: {} }));
      this.startListenRefreshLoop();
    });
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (typeof message.message_id === "string") {
        const pending = this.pending.get(message.message_id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(message.message_id);
          if (message.error_code || message.error) {
            pending.reject(new Error(message.details ?? message.error ?? `Matter command failed: ${message.error_code}`));
          } else {
            pending.resolve(message);
          }
          return;
        }
      }
      if (message.message_id === "matter-layer-start" && Array.isArray(message.result)) {
        this.ingestNodes(message.result, { markSourcesUpdated: false });
        void this.syncStartupSourceAttributes().finally(settleStartup);
      }
      if (message.event === "node_updated" && message.data) {
        this.lastMessageAt = Date.now();
        this.ingestNodes([message.data], { emitSourceValues: false });
      }
      if (message.event === "attribute_updated" || message.type === "attribute_updated") {
        this.lastMessageAt = Date.now();
        this.ingestEvent(message.data ?? message);
      }
      if (
        message.event === "node_event" ||
        message.event === "event" ||
        message.type === "event" ||
        message.type === "event_triggered"
      ) {
        this.lastMessageAt = Date.now();
        this.ingestDeviceEvent(message.data ?? message);
      }
    });
    ws.on("close", () => {
      this.connected = false;
      settleStartup();
      if (this.listenRefreshTimer) {
        clearInterval(this.listenRefreshTimer);
        this.listenRefreshTimer = undefined;
      }
      this.runtime?.notifyProviderChanged?.(this.name);
      for (const [messageId, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Matter websocket closed before response to ${messageId}`));
      }
      this.pending.clear();
      setTimeout(() => void this.connect(), 1000);
    });
    ws.on("error", () => {
      settleStartup();
    });
    return startupReady;
  }

  private async syncStartupSourceAttributes() {
    if (this.options.dryRun || this.startupAttributeSyncRunning) {
      return;
    }
    this.startupAttributeSyncRunning = true;
    try {
      const pathsByNode = this.startupReadPathsByNode();
      for (const [nodeId, paths] of pathsByNode) {
        let ok = false;
        for (const path of paths) {
          try {
            const response = await this.send(
              {
                command: "read_attribute",
                args: {
                  node_id: nodeId,
                  attribute_path: path,
                },
              },
              5_000,
            );
            const value = this.valueFromReadResponse(response, path);
            this.emitNodePath(nodeId, path, value, { markUpdated: true });
            ok = true;
          } catch {
            // Startup sync is best-effort; later subscriptions and stale probes keep sources fresh.
          }
        }
        if (paths.length > 0) {
          this.setNodeAvailability(nodeId, ok);
        }
      }
    } finally {
      this.startupAttributeSyncRunning = false;
    }
  }

  private startupReadPathsByNode() {
    const pathsByNode = new Map<number, Set<string>>();
    for (const [nodePath, bindings] of this.sourceByNodePath) {
      if (!bindings.some((binding) => binding.provider === "matter")) {
        continue;
      }
      const separator = nodePath.indexOf(":");
      const nodeId = Number(nodePath.slice(0, separator));
      const path = nodePath.slice(separator + 1);
      if (!Number.isFinite(nodeId) || !path) {
        continue;
      }
      let paths = pathsByNode.get(nodeId);
      if (!paths) {
        paths = new Set();
        pathsByNode.set(nodeId, paths);
      }
      paths.add(path);
    }
    return new Map([...pathsByNode.entries()].map(([nodeId, paths]) => [nodeId, [...paths]]));
  }

  private startListenRefreshLoop() {
    if (this.listenRefreshTimer) {
      clearInterval(this.listenRefreshTimer);
    }
    const intervalSec = Number(process.env.MATTER_LISTEN_REFRESH_INTERVAL_SEC ?? "300");
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
      return;
    }
    this.listenRefreshTimer = setInterval(() => {
      void this.refreshNodes().catch(() => {});
    }, Math.max(30, intervalSec) * 1000);
    this.listenRefreshTimer.unref?.();
  }

  private ingestNodes(nodes: any[], options: { markSourcesUpdated?: boolean; emitSourceValues?: boolean } = {}) {
    this.nodeCount = Math.max(this.nodeCount, nodes.length);
    let changed = false;
    for (const node of nodes) {
      const attrs = node.attributes ?? {};
      const nodeId = Number(node.node_id ?? node.nodeId ?? node.id);
      const label = attrs["0/40/5"] ?? node.name ?? node.label;
      const uniqueId = attrs["0/40/18"];
      const mac = macFromAttrs(attrs);
      const hasAvailable = "available" in node;
      const available = Boolean(node.available);
      if (Number.isFinite(nodeId) && typeof label === "string") {
        this.labelByNode.set(nodeId, label);
      }
      if (Number.isFinite(nodeId) && typeof uniqueId === "string" && uniqueId) {
        this.uniqueIdByNode.set(nodeId, uniqueId);
      }
      if (Number.isFinite(nodeId) && mac) {
        this.macByNode.set(nodeId, mac);
      }
      if (Number.isFinite(nodeId)) {
        const rssi = threadRssiFromAttrs(attrs);
        if (rssi === undefined) {
          this.rssiByNode.delete(nodeId);
        } else {
          this.rssiByNode.set(nodeId, rssi);
        }
      }
      if (Number.isFinite(nodeId) && hasAvailable && this.availableByNode.get(nodeId) !== available) {
        const wasAvailable = this.availableByNode.get(nodeId);
        this.availableByNode.set(nodeId, available);
        if (available) {
          this.offlineSinceByNode.delete(nodeId);
        } else if (wasAvailable === true) {
          this.offlineSinceByNode.set(nodeId, Date.now());
        }
        changed = true;
      }
      for (const binding of this.sources) {
        if (!binding.path || !this.matchesKey({ label, uniqueId, mac }, binding.key)) {
          continue;
        }
        if (Number.isFinite(nodeId)) {
          this.nodeByKey.set(binding.key, nodeId);
          const nodePath = `${nodeId}:${binding.path}`;
          const bindings = this.sourceByNodePath.get(nodePath) ?? [];
          if (!bindings.some((existing) => existing.source === binding.source)) {
            bindings.push(binding);
          }
          this.sourceByNodePath.set(nodePath, bindings);
        }
        if (options.emitSourceValues !== false && binding.path in attrs) {
          this.emit(binding, attrs[binding.path], {
            markUpdated: options.markSourcesUpdated,
          });
        }
      }
      for (const target of this.targets.values()) {
        if (this.matchesKey({ label, uniqueId, mac }, parentTarget(target.target)) && Number.isFinite(nodeId)) {
          this.nodeByKey.set(target.target, nodeId);
          if (!this.resolvedTargets.has(target.target)) {
            this.resolvedTargets.add(target.target);
          }
        }
      }
    }
    if (changed) {
      this.runtime?.notifyProviderChanged?.(this.name);
    }
  }

  private ingestEvent(event: any) {
    if (Array.isArray(event) && event.length >= 3) {
      const [nodeId, path, raw] = event;
      const bindings = this.sourceByNodePath.get(`${nodeId}:${path}`);
      if (!bindings) {
        return;
      }
      for (const binding of bindings) {
        this.emit(binding, raw);
      }
      return;
    }
    const nodeId = Number(event.node_id ?? event.nodeId ?? event.node);
    const endpoint = event.endpoint_id ?? event.endpointId ?? event.endpoint;
    const cluster = event.cluster_id ?? event.clusterId ?? event.cluster;
    const attribute = event.attribute_id ?? event.attributeId ?? event.attribute;
    const path = event.path ?? [endpoint, cluster, attribute].filter((part) => part !== undefined).join("/");
    const raw = event.value ?? event.data?.value;
    const bindings = this.sourceByNodePath.get(`${nodeId}:${path}`);
    if (!bindings) {
      return;
    }
    for (const binding of bindings) {
      this.emit(binding, raw);
    }
  }

  private ingestDeviceEvent(event: any) {
    const nodeId = Number(event.node_id ?? event.nodeId ?? event.node);
    const endpoint = Number(event.endpoint_id ?? event.endpointId ?? event.endpoint);
    const eventName = event.event_name ?? event.eventName ?? event.event ?? event.name;
    const eventId = Number(event.event_id ?? event.eventId);
    const clusterId = Number(event.cluster_id ?? event.clusterId ?? event.cluster);
    const matches = [...this.nodeByKey].filter(([, mappedNodeId]) => mappedNodeId === nodeId);
    const subject = matches[0]?.[0] ?? `node:${nodeId}`;
    let dispatchedEvent: string | undefined;
    for (const [key, mappedNodeId] of this.nodeByKey) {
      if (mappedNodeId !== nodeId) {
        continue;
      }
      const target = this.targets.get(key);
      const buttons = target?.capabilities?.buttons as Record<string, { endpoint: number }> | undefined;
      if (buttons && this.shouldDispatchButtonPress(key, nodeId, endpoint, eventName, eventId, target?.capabilities?.events?.initialPress)) {
        const button = Object.entries(buttons).find(([, spec]) => spec.endpoint === endpoint)?.[0];
        if (button && clusterId === 59) {
          const runtimeEvent = `${key}.button.${button}.initialPress`;
          this.runtimeWithEvents().dispatchEvent?.(runtimeEvent);
          dispatchedEvent ??= runtimeEvent;
        }
      }
      if (target?.capabilities?.switch && (String(eventName).toLowerCase().includes("initial") || eventId === 1)) {
        const spec = target.capabilities.switch as { cluster?: number; upEndpoint?: number; downEndpoint?: number };
        const direction = endpoint === (spec.upEndpoint ?? 1) ? "up" : endpoint === (spec.downEndpoint ?? 2) ? "down" : undefined;
        if (direction && clusterId === 59) {
          const runtimeEvent = `${key}.paddle.${direction}.singlePress`;
          this.runtimeWithEvents().dispatchEvent?.(runtimeEvent);
          dispatchedEvent ??= runtimeEvent;
        }
      }
    }
    this.runtime?.logMatter?.({
      at: Date.now(),
      direction: "received",
      kind: "event",
      subject,
      key: matches[0]?.[0],
      value: event,
      nodeId,
      endpoint: Number.isFinite(endpoint) ? endpoint : undefined,
      clusterId: Number.isFinite(clusterId) ? clusterId : undefined,
      eventId: Number.isFinite(eventId) ? eventId : undefined,
      eventName: typeof eventName === "string" ? eventName : undefined,
      event: dispatchedEvent,
    });
  }

  private shouldDispatchButtonPress(
    key: string,
    nodeId: number,
    endpoint: number,
    eventName: unknown,
    eventId: number,
    configuredInitialPress: unknown,
  ) {
    const eventKey = `${key}:${nodeId}:${endpoint}`;
    const now = Date.now();
    const isInitialPress = eventName === configuredInitialPress || eventId === 1;
    if (isInitialPress) {
      this.recentInitialPressByEndpoint.set(eventKey, now);
      return true;
    }
    const isFallbackPress = eventId === 5 || eventId === 6;
    if (!isFallbackPress) {
      return false;
    }
    const lastInitial = this.recentInitialPressByEndpoint.get(eventKey);
    if (lastInitial !== undefined && now - lastInitial < 4000) {
      return false;
    }
    return true;
  }

  private emit(binding: SourceBinding, raw: unknown, options: { markUpdated?: boolean } = {}) {
    const update: SourceUpdate = {
      source: binding.source,
      value: normalizeValue(binding, raw),
      provider: this.name,
      observedAt: Date.now(),
      markUpdated: options.markUpdated,
    };
    this.runtime?.updateSource(update);
  }

  private emitNodePath(nodeId: number, path: string, raw: unknown, options: { markUpdated?: boolean } = {}) {
    const bindings = this.sourceByNodePath.get(`${nodeId}:${path}`);
    if (!bindings) {
      return;
    }
    for (const binding of bindings) {
      this.emit(binding, raw, options);
    }
  }

  private probePathsForTarget(target: string, nodeId: number) {
    const keys = new Set([target, parentTarget(target)]);
    const paths = new Set<string>();
    for (const binding of this.sources) {
      if (binding.path && keys.has(binding.key)) {
        paths.add(binding.path);
      }
    }
    for (const nodePath of this.sourceByNodePath.keys()) {
      const [mappedNodeId, path] = nodePath.split(":", 2);
      if (Number(mappedNodeId) === nodeId && path) {
        paths.add(path);
      }
    }
    paths.add("0/40/5");
    return [...paths];
  }

  private startStaleProbeLoop() {
    const enabled = process.env.MATTER_STALE_PROBE_ENABLE?.toLowerCase() !== "0" && process.env.MATTER_STALE_PROBE_ENABLE?.toLowerCase() !== "false";
    if (!enabled || this.staleProbeTimer) {
      return;
    }
    const intervalMs = Math.max(1000, Number(process.env.MATTER_STALE_PROBE_INTERVAL_SEC ?? "60") * 1000);
    this.staleProbeTimer = setInterval(() => {
      void this.probeStaleTargets();
    }, intervalMs);
    this.staleProbeTimer.unref?.();
  }

  private startRemoteKeepaliveLoop() {
    const enabled = this.remoteKeepaliveEnabled()
      && process.env.MATTER_REMOTE_KEEPALIVE_ENABLE?.toLowerCase() !== "0"
      && process.env.MATTER_REMOTE_KEEPALIVE_ENABLE?.toLowerCase() !== "false";
    if (!enabled || this.remoteKeepaliveTimer) {
      return;
    }
    const intervalMs = Math.max(5000, Number(process.env.MATTER_REMOTE_KEEPALIVE_INTERVAL_SEC ?? "60") * 1000);
    this.remoteKeepaliveTimer = setInterval(() => {
      void this.pingRemoteTargets();
    }, intervalMs);
    this.remoteKeepaliveTimer.unref?.();
  }

  private async pingRemoteTargets() {
    if (this.options.dryRun || !this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.remoteKeepaliveRunning) {
      return;
    }
    this.remoteKeepaliveRunning = true;
    try {
      await this.pingRemoteTargetsOnce();
    } finally {
      this.remoteKeepaliveRunning = false;
    }
  }

  private async pingRemoteTargetsOnce() {
    const targets = this.remoteKeepaliveTargets();
    if (targets.length === 0) {
      return;
    }
    const maxPerPass = Math.max(1, Number(process.env.MATTER_REMOTE_KEEPALIVE_MAX_PER_PASS ?? "2"));
    const minIntervalMs = Math.max(5000, Number(process.env.MATTER_REMOTE_KEEPALIVE_PER_NODE_SEC ?? "120") * 1000);
    const now = Date.now();
    let pinged = 0;
    const visitedNodes = new Set<number>();
    for (let offset = 0; offset < targets.length && pinged < maxPerPass; offset += 1) {
      const index = (this.remoteKeepaliveCursor + offset) % targets.length;
      const target = targets[index];
      const nodeId = this.nodeByKey.get(target);
      if (!nodeId || visitedNodes.has(nodeId) || this.probingTargets.has(target)) {
        continue;
      }
      visitedNodes.add(nodeId);
      const lastNodePingAt = this.lastPingByNode.get(nodeId);
      if (lastNodePingAt !== undefined && now - lastNodePingAt < minIntervalMs) {
        continue;
      }
      this.probingTargets.add(target);
      try {
        await this.pingTarget(target);
        pinged += 1;
      } catch {
        pinged += 1;
      } finally {
        this.probingTargets.delete(target);
      }
    }
    this.remoteKeepaliveCursor = (this.remoteKeepaliveCursor + Math.max(1, pinged)) % targets.length;
  }

  private remoteKeepaliveTargets() {
    return [...this.targets.values()]
      .filter((target) => target.capabilities?.remoteKeepalive === true)
      .map((target) => target.target)
      .filter((target) => this.nodeByKey.has(target));
  }

  private async probeStaleTargets() {
    if (this.options.dryRun || !this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.staleProbeRunning) {
      return;
    }
    this.staleProbeRunning = true;
    try {
      await this.probeStaleTargetsOnce();
    } finally {
      this.staleProbeRunning = false;
    }
  }

  private async probeStaleTargetsOnce() {
    const availableStaleAfterMs = Math.max(1000, Number(process.env.MATTER_STALE_PROBE_AFTER_SEC ?? "60") * 1000);
    const unavailableStaleAfterMs = Math.max(
      availableStaleAfterMs,
      Number(process.env.MATTER_STALE_PROBE_UNAVAILABLE_AFTER_SEC ?? "300") * 1000,
    );
    const maxPerPass = Math.max(1, Number(process.env.MATTER_STALE_PROBE_MAX_PER_PASS ?? "64"));
    const now = Date.now();
    let probed = 0;
    const visitedNodes = new Set<number>();
    for (const target of this.threadSourceProbeTargets()) {
      if (probed >= maxPerPass) {
        break;
      }
      const nodeId = this.nodeByKey.get(target) ?? this.nodeByKey.get(parentTarget(target));
      if (!nodeId || visitedNodes.has(nodeId) || this.probingTargets.has(target)) {
        continue;
      }
      visitedNodes.add(nodeId);
      const staleAfterMs = this.availableByNode.get(nodeId) === true ? availableStaleAfterMs : unavailableStaleAfterMs;
      const sourceStats = this.sourceStatsForTarget(target, nodeId);
      if (!sourceStats.hasSources) {
        continue;
      }
      const lastUpdateAt = sourceStats.lastUpdateAt;
      const lastProbeAt = this.lastSourceProbeByNode.get(nodeId) ?? this.lastProbeByTarget.get(target);
      if ((lastUpdateAt ?? this.staleProbeStartedAt) > now - staleAfterMs) {
        continue;
      }
      if (lastProbeAt !== undefined && now - lastProbeAt < staleAfterMs) {
        continue;
      }
      this.probingTargets.add(target);
      this.lastSourceProbeByNode.set(nodeId, now);
      try {
        await this.probeTarget(target);
        probed += 1;
      } catch {
        // Stale probes are opportunistic; availability is updated by probeTarget.
        probed += 1;
      } finally {
        this.probingTargets.delete(target);
      }
    }
  }

  private threadSourceProbeTargets() {
    const byNode = new Map<number, string>();
    for (const binding of this.sources) {
      if (binding.provider !== "matter" || !binding.path) {
        continue;
      }
      const nodeId = this.nodeByKey.get(binding.key) ?? this.nodeByKey.get(parentTarget(binding.key));
      if (!nodeId || !this.rssiByNode.has(nodeId) || byNode.has(nodeId)) {
        continue;
      }
      byNode.set(nodeId, binding.key);
    }
    return [...byNode.values()];
  }

  private sourceStatsForTarget(target: string, nodeId: number) {
    const keys = new Set([target, parentTarget(target)]);
    const times: number[] = [];
    let hasSources = false;
    for (const binding of this.sources) {
      if (binding.path && keys.has(binding.key)) {
        hasSources = true;
        const updatedAt = this.sourceRefs.get(binding.source)?.updated();
        if (typeof updatedAt === "number") {
          times.push(updatedAt);
        }
      }
    }
    for (const [nodePath, bindings] of this.sourceByNodePath) {
      const [mappedNodeId] = nodePath.split(":", 1);
      if (Number(mappedNodeId) !== nodeId) {
        continue;
      }
      for (const binding of bindings) {
        hasSources = true;
        const updatedAt = this.sourceRefs.get(binding.source)?.updated();
        if (typeof updatedAt === "number") {
          times.push(updatedAt);
        }
      }
    }
    return { hasSources, lastUpdateAt: times.length ? Math.max(...times) : undefined };
  }

  private recordProbe(target: string) {
    const now = Date.now();
    this.lastProbeByTarget.set(target, now);
    const parent = parentTarget(target);
    if (parent !== target) {
      this.lastProbeByTarget.set(parent, now);
    }
    this.runtime?.notifyProviderChanged?.(this.name);
  }

  private valueFromReadResponse(response: unknown, path: string) {
    const result = (response as any)?.result;
    if (result && typeof result === "object" && !Array.isArray(result) && path in result) {
      return result[path];
    }
    return result;
  }

  private labelForKey(key: string) {
    const configured = matterLabelForKey(this.options.bindings ?? {}, key);
    if (configured) {
      return configured;
    }
    return key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(".")
      .map((part) => part.replace(/^\w/, (char) => char.toUpperCase()))
      .join(" ");
  }

  private matchesKey(identity: { label: unknown; uniqueId?: unknown; mac?: string | null }, key: string) {
    const configuredUniqueId = matterUniqueIdForKey(this.options.bindings ?? {}, key);
    if (configuredUniqueId && typeof identity.uniqueId === "string" && identity.uniqueId === configuredUniqueId) {
      return true;
    }
    const configuredMac = matterMacForKey(this.options.bindings ?? {}, key);
    if (configuredMac && identity.mac?.toLowerCase() === configuredMac.toLowerCase()) {
      return true;
    }
    return typeof identity.label === "string" && identity.label === this.labelForKey(key);
  }

  private translateCommand(command: DesiredCommand) {
    const target = this.targets.get(command.target);
    const capabilities = target?.capabilities;
    const nodeId = this.nodeByKey.get(command.target) ?? this.nodeByKey.get(parentTarget(command.target));
    if (!capabilities || !nodeId || !command.state) {
      return [];
    }
    const messages: any[] = [];
    if ("power" in command.state && capabilities.power?.commands) {
      const spec = capabilities.power.commands[command.state.power === "off" ? "off" : "on"];
      if (spec) {
        messages.push(this.deviceCommand(nodeId, spec));
      }
    }
    if ("level" in command.state && capabilities.level?.command) {
      const level = normalizeLevel(command.state.level);
      messages.push(
        this.deviceCommand(nodeId, capabilities.level.command, {
          level,
          transitionTime: 0,
          optionsMask: 0,
          optionsOverride: 0,
        }),
      );
    }
    if ("color" in command.state && capabilities.color) {
      const color = normalizeColor(command.state.color);
      if (color) {
        messages.push(
          this.deviceCommand(
            nodeId,
            { endpoint: capabilities.color.endpoint, cluster: capabilities.color.cluster, command: "MoveToHueAndSaturation" },
            color,
          ),
        );
      }
    }
    if ("position" in command.state && capabilities.commands) {
      const spec = capabilities.commands[coverPositionCommandKey(command.state.position)];
      if (spec) {
        messages.push(this.deviceCommand(nodeId, spec));
      }
    }
    if ("motion" in command.state && capabilities.commands) {
      const spec = capabilities.commands[String(command.state.motion)];
      if (spec) {
        messages.push(this.deviceCommand(nodeId, spec));
      }
    }
    return messages;
  }

  private deviceCommand(nodeId: number, spec: any, payload: Record<string, unknown> = {}) {
    return {
      command: "device_command",
      args: {
        node_id: nodeId,
        endpoint_id: spec.endpoint,
        cluster_id: spec.cluster,
        command_name: spec.command,
        payload: {
          ...(spec.payload ?? {}),
          ...payload,
        },
      },
    };
  }

  private nodeIdForTarget(target: string) {
    const nodeId = this.nodeByKey.get(target) ?? this.nodeByKey.get(parentTarget(target));
    if (!nodeId) {
      throw new Error(`No Matter node resolved for ${target}`);
    }
    return nodeId;
  }

  private setNodeAvailability(nodeId: number, available: boolean) {
    const wasAvailable = this.availableByNode.get(nodeId);
    if (wasAvailable === available) {
      return;
    }
    this.availableByNode.set(nodeId, available);
    if (available) {
      this.offlineSinceByNode.delete(nodeId);
    } else if (wasAvailable === true) {
      this.offlineSinceByNode.set(nodeId, Date.now());
    }
    this.runtime?.notifyProviderChanged?.(this.name);
  }

  private send(message: any, timeoutMs = 5000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Matter websocket is not connected");
    }
    const messageId = `matter-layer-${++this.nextMessageId}`;
    this.ws.send(
      JSON.stringify({
        message_id: messageId,
        ...message,
      }),
    );
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Matter websocket timed out waiting for ${messageId}`));
      }, timeoutMs);
      this.pending.set(messageId, { resolve, reject, timeout });
    });
  }

  private runtimeWithEvents() {
    return this.runtime as Runtime & { dispatchEvent?(event: string): boolean };
  }
}

function normalizeLevel(value: unknown) {
  if (typeof value === "string" && value.endsWith("%")) {
    return Math.round((Number(value.slice(0, -1)) / 100) * 254);
  }
  return value;
}

function normalizeColor(value: unknown) {
  if (value === "green") {
    return colorPayload(85);
  }
  if (value === "blue") {
    return colorPayload(170);
  }
  if (value === "purple") {
    return colorPayload(212);
  }
  return null;
}

function pingResultIsReachable(result: unknown) {
  if (typeof result === "boolean") {
    return result;
  }
  if (Array.isArray(result)) {
    return result.some((value) => value === true);
  }
  if (result && typeof result === "object") {
    return Object.values(result).some((value) => value === true);
  }
  return Boolean(result);
}

function colorPayload(hue: number) {
  return {
    hue,
    saturation: 254,
    transitionTime: 0,
    optionsMask: 0,
    optionsOverride: 0,
  };
}

function parentTarget(target: string) {
  return target.replace(/\.endpoint\.\d+\..*$/, "");
}

function coverPositionCommandKey(value: unknown) {
  if (value === "closed") {
    return "close";
  }
  return String(value);
}

function macFromAttrs(attrs: Record<string, any>) {
  for (const entry of attrs["0/51/0"] ?? []) {
    const hardwareAddress = entry?.["4"];
    if (typeof hardwareAddress !== "string") {
      continue;
    }
    try {
      const bytes = Buffer.from(`${hardwareAddress}===`, "base64");
      if (bytes.length >= 6) {
        return [...bytes.subarray(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
      }
    } catch {
      return null;
    }
  }
  return null;
}

function threadRssiFromAttrs(attrs: Record<string, any>) {
  const values: number[] = [];
  const neighborTable = attrs["0/53/7"];
  if (Array.isArray(neighborTable)) {
    for (const entry of neighborTable) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const parsed = parseRssi((entry as Record<string, unknown>)["6"]);
      if (parsed !== undefined) {
        values.push(parsed);
      }
    }
  }
  return values.length ? Math.max(...values) : undefined;
}

function parseRssi(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  if (rounded >= -127 && rounded <= 0) {
    return rounded;
  }
  if (rounded >= 128 && rounded <= 255) {
    const signed = rounded - 256;
    return signed >= -127 && signed <= 0 ? signed : undefined;
  }
  return undefined;
}
