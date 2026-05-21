import WebSocket from "ws";
import { matterLabelForKey, matterMacForKey, type MatterBinding } from "../../config/bindings";
import { normalizeValue } from "../../runtime/sources";
import type {
  CommandResult,
  DesiredCommand,
  ProviderAdapter,
  Runtime,
  SourceBinding,
  SourceUpdate,
} from "../../runtime/types";

export class MatterProvider implements ProviderAdapter {
  readonly name = "matter" as const;
  private runtime?: Runtime & { enqueueApply?: (target: string) => void; notifyProviderChanged?: (provider: "matter") => void };
  private sources: SourceBinding[] = [];
  private targets = new Map<string, { target: string; capabilities: Record<string, any> }>();
  private ws?: WebSocket;
  private connected = false;
  private nodeCount = 0;
  private lastMessageAt?: number;
  private nodeByKey = new Map<string, number>();
  private resolvedTargets = new Set<string>();
  private labelByNode = new Map<number, string>();
  private macByNode = new Map<number, string>();
  private availableByNode = new Map<number, boolean>();
  private offlineSinceByNode = new Map<number, number>();
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
      bindings?: Record<string, MatterBinding>;
    },
  ) {}

  start(
    runtime: Runtime & {
      sources?: Map<string, { binding: SourceBinding }>;
      targets?: Map<string, any>;
      enqueueApply?: (target: string) => void;
      notifyProviderChanged?: (provider: "matter") => void;
    },
  ) {
    this.runtime = runtime;
    if (runtime.sources) {
      this.sources = [...runtime.sources.values()].map((source) => source.binding);
    }
    if (runtime.targets) {
      this.targets = new Map(
        [...runtime.targets.entries()].map(([target, binding]) => [target, binding]),
      );
    }
    if (this.options.enabled === false) {
      return;
    }
    this.connect();
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
    const started = Date.now();
    try {
      const response = await this.send({ command: "ping_node", args: { node_id: nodeId } }, 15_000);
      this.setNodeAvailability(nodeId, true);
      return { ok: true, dryRun: false, target, nodeId, elapsedMs: Date.now() - started, result: (response as any).result };
    } catch (error) {
      this.setNodeAvailability(nodeId, false);
      throw error;
    }
  }

  async probeTarget(target: string) {
    if (this.options.dryRun) {
      return { ok: true, dryRun: true, target };
    }
    const nodeId = this.nodeIdForTarget(target);
    const started = Date.now();
    try {
      const response = await this.send(
        {
          command: "read_attribute",
          args: {
            node_id: nodeId,
            attribute_path: "0/40/5",
          },
        },
        5_000,
      );
      this.setNodeAvailability(nodeId, true);
      return { ok: true, dryRun: false, target, nodeId, elapsedMs: Date.now() - started, result: (response as any).result };
    } catch (error) {
      this.setNodeAvailability(nodeId, false);
      throw error;
    }
  }

  snapshot() {
    return {
      enabled: this.options.enabled !== false,
      connected: this.connected,
      url: this.options.url,
      nodeCount: this.nodeCount,
      lastMessageAt: this.lastMessageAt,
      resolved: [...this.nodeByKey.entries()].map(([key, nodeId]) => ({
        key,
        nodeId,
        label: this.labelByNode.get(nodeId),
        mac: this.macByNode.get(nodeId),
        available: this.availableByNode.get(nodeId),
        offlineSince: this.offlineSinceByNode.get(nodeId),
      })),
      unresolvedSources: this.sources
        .filter((source) => this.options.enabled !== false && source.provider === "matter" && !this.nodeByKey.has(source.key))
        .map((source) => source.source),
      unresolvedTargets: this.options.enabled === false ? [] : [...this.targets.keys()].filter((target) => !this.nodeByKey.has(target)),
    };
  }

  private connect() {
    const ws = new WebSocket(this.options.url, { maxPayload: 1024 * 1024 * 32 });
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.runtime?.notifyProviderChanged?.(this.name);
      ws.send(JSON.stringify({ message_id: "matter-layer-start", command: "start_listening", args: {} }));
    });
    ws.on("message", (data) => {
      this.lastMessageAt = Date.now();
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
        this.ingestNodes(message.result);
      }
      if (message.event === "node_updated" && message.data) {
        this.ingestNodes([message.data]);
      }
      if (message.event === "attribute_updated" || message.type === "attribute_updated") {
        this.ingestEvent(message.data ?? message);
      }
      if (
        message.event === "node_event" ||
        message.event === "event" ||
        message.type === "event" ||
        message.type === "event_triggered"
      ) {
        this.ingestDeviceEvent(message.data ?? message);
      }
    });
    ws.on("close", () => {
      this.connected = false;
      this.runtime?.notifyProviderChanged?.(this.name);
      for (const [messageId, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Matter websocket closed before response to ${messageId}`));
      }
      this.pending.clear();
      setTimeout(() => this.connect(), 1000);
    });
  }

  private ingestNodes(nodes: any[]) {
    this.nodeCount = Math.max(this.nodeCount, nodes.length);
    let changed = false;
    for (const node of nodes) {
      const attrs = node.attributes ?? {};
      const nodeId = Number(node.node_id ?? node.nodeId ?? node.id);
      const label = attrs["0/40/5"] ?? node.name ?? node.label;
      const mac = macFromAttrs(attrs);
      const hasAvailable = "available" in node;
      const available = Boolean(node.available);
      if (Number.isFinite(nodeId) && typeof label === "string") {
        this.labelByNode.set(nodeId, label);
      }
      if (Number.isFinite(nodeId) && mac) {
        this.macByNode.set(nodeId, mac);
      }
      if (Number.isFinite(nodeId) && hasAvailable && this.availableByNode.get(nodeId) !== available) {
        this.availableByNode.set(nodeId, available);
        if (available) {
          this.offlineSinceByNode.delete(nodeId);
        } else {
          this.offlineSinceByNode.set(nodeId, Date.now());
        }
        changed = true;
      }
      for (const binding of this.sources) {
        if (!binding.path || !this.matchesKey({ label, mac }, binding.key)) {
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
        if (binding.path in attrs) {
          this.emit(binding, attrs[binding.path]);
        }
      }
      for (const target of this.targets.values()) {
        if (this.matchesKey({ label, mac }, parentTarget(target.target)) && Number.isFinite(nodeId)) {
          this.nodeByKey.set(target.target, nodeId);
          if (!this.resolvedTargets.has(target.target)) {
            this.resolvedTargets.add(target.target);
            this.runtime?.enqueueApply?.(target.target);
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
    for (const [key, mappedNodeId] of this.nodeByKey) {
      if (mappedNodeId !== nodeId) {
        continue;
      }
      const target = this.targets.get(key);
      const buttons = target?.capabilities?.buttons as Record<string, { endpoint: number }> | undefined;
      if (buttons && (eventName === target?.capabilities?.events?.initialPress || eventId === 1 || eventId === 5 || eventId === 6)) {
        const button = Object.entries(buttons).find(([, spec]) => spec.endpoint === endpoint)?.[0];
        if (button && clusterId === 59) {
          this.runtimeWithEvents().dispatchEvent?.(`${key}.button.${button}.initialPress`);
        }
      }
      if (target?.capabilities?.switch && (String(eventName).toLowerCase().includes("initial") || eventId === 1)) {
        const spec = target.capabilities.switch as { cluster?: number; upEndpoint?: number; downEndpoint?: number };
        const direction = endpoint === (spec.upEndpoint ?? 1) ? "up" : endpoint === (spec.downEndpoint ?? 2) ? "down" : undefined;
        if (direction && clusterId === 59) {
          this.runtimeWithEvents().dispatchEvent?.(`${key}.paddle.${direction}.singlePress`);
        }
      }
    }
  }

  private emit(binding: SourceBinding, raw: unknown) {
    const update: SourceUpdate = {
      source: binding.source,
      value: normalizeValue(binding, raw),
      provider: this.name,
      observedAt: Date.now(),
    };
    this.runtime?.updateSource(update);
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

  private matchesKey(identity: { label: unknown; mac?: string | null }, key: string) {
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
    if (this.availableByNode.get(nodeId) === available) {
      return;
    }
    this.availableByNode.set(nodeId, available);
    if (available) {
      this.offlineSinceByNode.delete(nodeId);
    } else {
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
