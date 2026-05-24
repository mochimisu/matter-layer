import { EventEmitter } from "node:events";
import {
  createDefinitionRoom,
  createRoomProxy,
  createRuleRegistration,
  setRuleRegistrar,
  type RoomModule,
} from "./dsl";
import { LayerStore } from "./layers";
import { SourceRef } from "./sources";
import { track } from "./tracking";
import { setActiveRuleName, setDeviceRuntime, type DeviceRuntime } from "./devices";
import { Signal } from "./signals";
import { clockSource } from "./builtins";
import { setSchedulerRuntime } from "./scheduler";
import { parseDuration } from "./state";
import { pulseSnapshot } from "./state";
import type {
  CommandResult,
  DesiredCommand,
  LayerName,
  LayerOutput,
  MatterLogEntry,
  ProviderAdapter,
  ProviderName,
  Runtime,
  RuntimeEvent,
  SourceBinding,
  SourceUpdate,
  TargetBinding,
} from "./types";

export class MatterLayerRuntime implements Runtime, DeviceRuntime {
  readonly events = new EventEmitter();
  readonly rooms = new Map<string, Record<string, unknown>>();
  readonly ruleRooms = new Map<string, any>();
  readonly signals = new Map<string, Signal>();
  readonly sources = new Map<string, SourceRef>();
  readonly targets = new Map<string, TargetBinding>();
  readonly rules = new Map<string, ReturnType<typeof createRuleRegistration>>();
  readonly layers = new LayerStore();
  readonly providers = new Map<string, ProviderAdapter>();
  readonly commandResults: CommandResult[] = [];
  readonly matterLog: MatterLogEntry[] = [];
  readonly eventHandlers = new Map<string, Set<() => void>>();
  readonly sourceHandlers = new Map<string, Set<(update: SourceUpdate) => void>>();
  readonly eventActions = new Map<string, { name: string; event: string; outputs: Set<string>; lastRunAt?: number }>();
  private readonly applyingTargets = new Set<string>();
  private readonly pendingCommands = new Map<string, DesiredCommand>();
  private readonly scheduled = new Map<string, NodeJS.Timeout>();
  private nextMatterLogId = 0;
  private clock?: NodeJS.Timeout;
  private activeRule?: string;

  constructor(readonly options: { dryRun?: boolean } = {}) {
    this.registerSource(clockSource);
    clockSource.update(Date.now(), Date.now());
    setSchedulerRuntime(this);
  }

  registerProvider(provider: ProviderAdapter) {
    this.providers.set(provider.name, provider);
  }

  registerSource(source: SourceRef) {
    this.sources.set(source.source, source);
  }

  registerTarget(binding: TargetBinding) {
    this.targets.set(binding.target, binding);
  }

  registerInternalRule(name: string, run: () => void) {
    if (!this.rules.has(name)) {
      this.rules.set(name, createRuleRegistration(name, run));
    }
  }

  registerEventHandler(event: string, handler: () => void) {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
  }

  registerSourceHandler(source: string, handler: (update: SourceUpdate) => void) {
    let handlers = this.sourceHandlers.get(source);
    if (!handlers) {
      handlers = new Set();
      this.sourceHandlers.set(source, handlers);
    }
    handlers.add(handler);
  }

  registerEventAction(action: { name: string; event: string; outputs: string[] }) {
    const existing = this.eventActions.get(action.name);
    if (existing) {
      for (const output of action.outputs) {
        existing.outputs.add(output);
      }
      return;
    }
    this.eventActions.set(action.name, {
      name: action.name,
      event: action.event,
      outputs: new Set(action.outputs),
    });
  }

  recordRuleOutput(target: string) {
    if (!this.activeRule) {
      return;
    }
    this.rules.get(this.activeRule)?.outputs.add(target);
  }

  writeLayer(target: string, layer: LayerName, output: LayerOutput | null) {
    const before = this.layerFingerprint(target);
    this.layers.write(target, layer, output);
    if (before !== this.layerFingerprint(target)) {
      this.emit({ type: "layer.changed", target, layer, output });
      this.updateActiveLayerSource(target);
    }
    if (output?.expiresAt) {
      this.scheduleAt(output.expiresAt, `layer.${target}.${layer}`);
    }
  }

  clearLayer(target: string, layer: LayerName) {
    const before = this.layerFingerprint(target);
    this.layers.clear(target, layer);
    if (before !== this.layerFingerprint(target)) {
      this.emit({ type: "layer.changed", target, layer, output: null });
      this.updateActiveLayerSource(target);
    }
    this.enqueueApply(target);
  }

  hasLayer(target: string, layer: LayerName) {
    return Boolean(this.layers.layer(target, layer));
  }

  surfaceLayer(target: string) {
    return this.layers.surface(target);
  }

  enqueueApply(target: string) {
    const command = this.layers.desiredCommand(target);
    if (!command || !this.layers.shouldApply(command)) {
      return;
    }
    this.queueCommand(command);
  }

  async applyCommand(command: DesiredCommand): Promise<CommandResult> {
    return this.performApplyCommand(command);
  }

  private queueCommand(command: DesiredCommand) {
    if (this.applyingTargets.has(command.target)) {
      this.pendingCommands.set(command.target, command);
      return;
    }
    void this.drainCommandQueue(command);
  }

  private async drainCommandQueue(command: DesiredCommand) {
    this.applyingTargets.add(command.target);
    let next: DesiredCommand | undefined = command;
    try {
      while (next) {
        await this.performApplyCommand(next);
        next = this.pendingCommands.get(command.target);
        this.pendingCommands.delete(command.target);
      }
    } finally {
      this.applyingTargets.delete(command.target);
    }
  }

  private async performApplyCommand(command: DesiredCommand): Promise<CommandResult> {
    const provider = this.providers.get("matter");
    const result = provider?.apply
      ? await provider.apply(command)
      : {
          command,
          provider: "matter" as const,
          dryRun: Boolean(this.options.dryRun),
          ok: true,
          appliedAt: Date.now(),
    };
    this.commandResults.push(result);
    if (result.provider === "matter") {
      this.recordMatterLog({
        at: result.appliedAt,
        direction: "sent",
        kind: "command",
        subject: command.target,
        key: command.target,
        state: command.state,
        reason: command.reason,
        ok: result.ok,
        error: result.error,
      });
    }
    if (!result.ok) {
      this.layers.forgetDesired(command.target);
    }
    this.emit({ type: "command", result });
    return result;
  }

  async forceApplyCurrent(options: { room?: string } = {}) {
    const results: CommandResult[] = [];
    for (const target of this.targets.keys()) {
      if (options.room && options.room !== "all" && roomOf(target) !== options.room) {
        continue;
      }
      const command = this.layers.desiredCommand(target);
      if (!command) {
        continue;
      }
      results.push(await this.applyCommand(command));
    }
    return results;
  }

  updateSource(update: SourceUpdate) {
    const source = this.sources.get(update.source);
    if (!source) {
      if (update.provider === "synthetic") {
        this.emit({ type: "source.changed", update });
        this.evaluateAffectedSignals(update.source);
        this.runAffected(update.source);
      }
      return;
    }
    if (!source.update(update.value, update.observedAt, { markUpdated: update.markUpdated })) {
      return;
    }
    if (update.provider === "matter") {
      this.recordMatterLog({
        at: update.observedAt,
        direction: "received",
        kind: "source",
        subject: update.source,
        key: source.binding.key,
        property: source.binding.property,
        value: update.value,
      });
    }
    this.emit({ type: "source.changed", update });
    this.dispatchSourceChange(update);
    this.evaluateAffectedSignals(update.source);
    this.runAffected(update.source);
  }

  async start() {
    this.startClock();
    for (const provider of this.providers.values()) {
      await provider.start?.(this);
    }
    this.runAll();
  }

  stop() {
    if (this.clock) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
    for (const timeout of this.scheduled.values()) {
      clearTimeout(timeout);
    }
    this.scheduled.clear();
    setSchedulerRuntime(null);
  }

  loadModules(modules: { devices: RoomModule[]; rules: RoomModule[] }) {
    setDeviceRuntime(this);
    try {
      for (const module of modules.devices) {
        const state = this.roomState(module.room);
        module.setup({
          room: createDefinitionRoom(state),
          rooms: this.roomProxyMap(),
          matter: {},
        });
      }
      for (const module of modules.rules) {
        const state = this.roomState(module.room);
        const room = createRoomProxy(state);
        this.ruleRooms.set(module.room, room);
        setRuleRegistrar((name, run) => {
          const id = `${module.room}.${name}`;
          this.rules.set(id, createRuleRegistration(id, run));
        });
        module.setup({
          room,
          rooms: this.roomProxyMap(),
          rule: (name: string, run: any) => {
            const maybeRun = typeof run === "function" ? run : () => run;
            const id = `${module.room}.${name}`;
            this.rules.set(id, createRuleRegistration(id, maybeRun));
          },
        });
        setRuleRegistrar(null);
      }
      this.collectSignals();
      this.evaluateAllSignals();
    } finally {
      setRuleRegistrar(null);
    }
  }

  runAll() {
    for (const rule of this.rules.values()) {
      this.runRule(rule.name);
    }
  }

  runRule(name: string) {
    const rule = this.rules.get(name);
    if (!rule || !rule.enabled) {
      return;
    }
    try {
      this.activeRule = rule.name;
      rule.outputs.clear();
      setActiveRuleName(rule.name);
      const result = track(rule.run);
      rule.deps = result.deps;
      rule.lastRunAt = Date.now();
      rule.lastError = undefined;
      this.emit({ type: "rule.run", name });
    } catch (error) {
      rule.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      setActiveRuleName(null);
      this.activeRule = undefined;
    }
  }

  setRuleEnabled(name: string, enabled: boolean) {
    const rule = this.rules.get(name);
    if (!rule) {
      return false;
    }
    rule.enabled = enabled;
    if (enabled) {
      this.runRule(name);
    }
    this.emit({ type: "rule.run", name });
    return true;
  }

  setWebOverride(target: string, state: Record<string, unknown> | null, options: { reason?: string; ttl?: string } = {}) {
    const expiresAt = options.ttl ? Date.now() + parseDuration(options.ttl) : undefined;
    this.writeLayer(target, "webOverride", {
      state,
      reason: options.reason ?? "Web override",
      writer: "web",
      expiresAt,
    });
    this.enqueueApply(target);
  }

  dispatchEvent(event: string) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) {
      return false;
    }
    for (const handler of handlers) {
      handler();
    }
    for (const action of this.eventActions.values()) {
      if (action.event === event) {
        action.lastRunAt = Date.now();
      }
    }
    this.emit({ type: "device.event", event });
    return true;
  }

  private dispatchSourceChange(update: SourceUpdate) {
    const handlers = this.sourceHandlers.get(update.source);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      handler(update);
    }
  }

  notifyProviderChanged(provider: ProviderName) {
    this.emit({ type: "provider.changed", provider });
  }

  scheduleAt(at: number, reason: string) {
    const delay = Math.max(0, at - Date.now());
    const existing = this.scheduled.get(reason);
    if (existing) {
      clearTimeout(existing);
    }
    const timeout = setTimeout(() => {
      this.scheduled.delete(reason);
      if (reason.startsWith("pulse.")) {
        this.updateSource({
          source: reason,
          value: Date.now(),
          provider: "synthetic",
          observedAt: Date.now(),
        });
        this.expireLayers();
        return;
      }
      this.updateSource({
        source: clockSource.source,
        value: Date.now(),
        provider: "timer",
        observedAt: Date.now(),
      });
      this.expireLayers();
    }, delay);
    this.scheduled.set(reason, timeout);
  }

  runAffected(source: string) {
    for (const rule of this.rules.values()) {
      if (rule.deps.has(source)) {
        this.runRule(rule.name);
      }
    }
  }

  evaluateAllSignals() {
    for (const signal of this.signals.values()) {
      signal.evaluate();
    }
  }

  evaluateAffectedSignals(source: string) {
    const queue = [source];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const signal of this.signals.values()) {
        if (!signal.registration.initialized || signal.registration.deps.has(current)) {
          const changed = signal.evaluate();
          if (changed) {
            this.emit({ type: "signal.changed", id: signal.id, value: signal.peek() });
            this.runAffected(signal.id);
            queue.push(signal.id);
          }
        }
      }
    }
  }

  snapshot() {
    return {
      sources: [...this.sources.values()].map((source) => ({
        ...source.binding,
        value: source.peek(),
        since: source.since(),
        updatedAt: source.updated(),
      })),
      signals: [...this.signals.values()].map((signal) => ({
        id: signal.id,
        value: signal.peek(),
        deps: [...signal.registration.deps],
        initialized: signal.registration.initialized,
        lastRunAt: signal.registration.lastRunAt,
      })),
      targets: [...this.targets.values()].map((target) => ({
        ...target,
        display: this.targetDisplaySnapshot(target),
      })),
      rules: [...this.rules.values()].map((rule) => ({
        name: rule.name,
        enabled: rule.enabled,
        deps: [...rule.deps],
        outputs: [...rule.outputs],
        lastRunAt: rule.lastRunAt,
        lastError: rule.lastError,
      })),
      layers: this.layers.snapshot(),
      commands: this.commandResults.slice(-50),
      matterLog: this.matterLog.slice(-200),
      events: [...this.eventHandlers.keys()],
      eventActions: [...this.eventActions.values()].map((action) => ({
        name: action.name,
        event: action.event,
        outputs: [...action.outputs],
        lastRunAt: action.lastRunAt,
      })),
      pulses: pulseSnapshot(),
      providers: [...this.providers.values()].map((provider) => ({
        name: provider.name,
        status: provider.snapshot?.() ?? null,
      })),
    };
  }

  private targetDisplaySnapshot(target: TargetBinding) {
    const status = target.display?.status;
    const battery = target.display?.battery;
    const rssi = target.display?.rssi;
    const metrics = target.display?.metrics;
    return {
      ...target.display,
      status: status
        ? {
            ...status,
            value: this.sources.get(status.source)?.peek(),
            since: this.sources.get(status.source)?.since(),
            updatedAt: this.sources.get(status.source)?.updated(),
          }
        : undefined,
      battery: battery
        ? {
            ...battery,
            value: this.sources.get(battery.source)?.peek(),
            since: this.sources.get(battery.source)?.since(),
            updatedAt: this.sources.get(battery.source)?.updated(),
          }
        : undefined,
      rssi: rssi
        ? {
            ...rssi,
            value: this.sources.get(rssi.source)?.peek(),
            since: this.sources.get(rssi.source)?.since(),
            updatedAt: this.sources.get(rssi.source)?.updated(),
          }
        : undefined,
      metrics: metrics?.map((metric) => ({
        ...metric,
        value: this.sources.get(metric.source)?.peek(),
        since: this.sources.get(metric.source)?.since(),
        updatedAt: this.sources.get(metric.source)?.updated(),
      })),
    };
  }

  graph() {
    const rules = [...this.rules.values()];
    return {
      nodes: [
        ...[...this.sources.keys()].map((id) => ({ id, type: "source" })),
        ...rules.map((rule) => ({ id: rule.name, type: "rule" })),
        ...[...this.targets.keys()].map((id) => ({ id, type: "target" })),
      ],
      edges: rules.flatMap((rule) => [
        ...[...rule.deps].map((dep) => ({
          from: dep,
          to: rule.name,
          type: "read",
        })),
        ...[...rule.outputs].map((target) => ({
          from: rule.name,
          to: target,
          type: "write",
        })),
      ]),
    };
  }

  onEvent(listener: (event: RuntimeEvent) => void) {
    this.events.on("event", listener);
  }

  private emit(event: RuntimeEvent) {
    this.events.emit("event", event);
  }

  private recordMatterLog(entry: Omit<MatterLogEntry, "id">) {
    this.matterLog.push({ id: ++this.nextMatterLogId, ...entry });
    if (this.matterLog.length > 200) {
      this.matterLog.splice(0, this.matterLog.length - 200);
    }
  }

  private layerFingerprint(target: string) {
    return JSON.stringify(this.layers.snapshot().find((layer) => layer.target === target) ?? null);
  }

  private updateActiveLayerSource(target: string) {
    const source = this.sources.get(`${target}.activeLayer`);
    if (!source) {
      return;
    }
    const surfaced = this.layers.surface(target);
    this.updateSource({
      source: source.source,
      value: surfaced
        ? {
            layer: surfaced.layer,
            state: surfaced.output.state,
            power: surfaced.output.state?.power,
            reason: surfaced.output.reason,
          }
        : null,
      provider: "synthetic",
      observedAt: Date.now(),
    });
  }

  private roomState(room: string) {
    let state = this.rooms.get(room);
    if (!state) {
      state = {};
      this.rooms.set(room, state);
    }
    return state;
  }

  private collectSignals() {
    for (const [room, state] of this.rooms) {
      for (const [name, value] of Object.entries(state)) {
        if (value instanceof Signal) {
          value.rename(`${room}.${name}`);
          this.signals.set(value.id, value);
        }
      }
    }
  }

  private startClock() {
    this.clock ??= setInterval(() => {
      this.updateSource({
        source: clockSource.source,
        value: Date.now(),
        provider: "timer",
        observedAt: Date.now(),
      });
      this.expireLayers();
    }, 100);
  }

  private expireLayers() {
    for (const target of this.targets.keys()) {
      const expired = this.layers.expire(target, Date.now());
      if (expired.length > 0) {
        for (const layer of expired) {
          this.emit({ type: "layer.changed", target, layer, output: null });
        }
        this.enqueueApply(target);
      }
    }
  }

  private roomProxyMap() {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== "string") {
            return undefined;
          }
          return createRoomProxy(this.roomState(prop));
        },
      },
    );
  }
}

export function sourceBindings(runtime: MatterLayerRuntime): SourceBinding[] {
  return [...runtime.sources.values()].map((source) => source.binding);
}

function roomOf(id: string) {
  return id.split(".")[0] ?? id;
}
