import { makeSource, SourceRef } from "./sources";
import type {
  DesiredCommand,
  DeviceBatteryDisplay,
  DeviceMetricDisplay,
  DeviceRssiDisplay,
  DeviceStatusDisplay,
  LayerName,
  LayerOutput,
  SourceUpdate,
  TargetBinding,
  TargetId,
} from "./types";

const deviceState = globalThis as typeof globalThis & {
  __matterLayerDeviceRuntime?: DeviceRuntime | null;
  __matterLayerActiveRuleName?: string | null;
};

export type DeviceRuntime = {
  registerSource(source: SourceRef): void;
  registerTarget(binding: TargetBinding): void;
  registerInternalRule(name: string, run: () => void): void;
  registerEventHandler(event: string, handler: () => void): void;
  registerSourceHandler(source: string, handler: (update: SourceUpdate) => void): void;
  registerEventAction(action: { name: string; event: string; outputs: TargetId[] }): void;
  recordRuleOutput(target: TargetId): void;
  writeLayer(target: TargetId, layer: LayerName, output: LayerOutput | null): void;
  clearLayer(target: TargetId, layer: LayerName): void;
  hasLayer(target: TargetId, layer: LayerName): boolean;
  surfaceLayer(target: TargetId): { layer: LayerName; output: LayerOutput; since?: number } | null;
  updateSource(update: SourceUpdate): void;
  enqueueApply(target: TargetId): void;
};

export type ActiveLayerState = {
  layer: LayerName;
  state: Record<string, unknown> | null;
  power?: unknown;
  reason?: string;
} | null;

export function setDeviceRuntime(runtime: DeviceRuntime | null) {
  deviceState.__matterLayerDeviceRuntime = runtime;
}

export function setActiveRuleName(name: string | null) {
  deviceState.__matterLayerActiveRuleName = name;
}

function runtime() {
  if (!deviceState.__matterLayerDeviceRuntime) {
    throw new Error("No matter-layer runtime is active");
  }
  return deviceState.__matterLayerDeviceRuntime;
}

export type LightOptions = Record<string, unknown> & {
  on?: Record<string, unknown>;
  status?: DeviceStatusOptions;
  battery?: DeviceBatteryOptions;
  rssi?: DeviceRssiOptions;
  metrics?: DeviceMetricOptions[];
};

export type DeviceStatusOptions = {
  property?: string;
  path: string;
  encoding?: string;
  when?: unknown;
  label?: string;
  values?: DeviceStatusDisplay["values"];
};

export type DeviceBatteryOptions = {
  property?: string;
  path: string;
  encoding?: "matter-battery-percent" | "matter-battery-voltage";
  label?: string;
};

export type DeviceMetricOptions = {
  property: string;
  path: string;
  encoding?: string;
  label: string;
  unit?: string;
};

export type DeviceRssiOptions = {
  property?: string;
  path: string;
  encoding?: string;
  label?: string;
  unit?: string;
};

export class LayerSlot {
  constructor(
    private readonly target: string,
    private readonly layer: LayerName,
  ) {}

  clear() {
    runtime().clearLayer(this.target, this.layer);
  }
}

export class LayerProxy {
  constructor(private readonly target: string) {}

  get override(): any {
    return runtime().hasLayer(this.target, "override") ? new LayerSlot(this.target, "override") : undefined;
  }

  set override(output: any) {
    runtime().writeLayer(this.target, "override", output);
    runtime().enqueueApply(this.target);
  }
}

export class TargetDevice {
  readonly key: string;
  readonly layer: LayerProxy;
  readonly state: Record<string, unknown> = {};
  readonly defaults: Record<string, unknown>;

  constructor(key: string, capabilities: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}) {
    this.key = key;
    this.layer = new LayerProxy(key);
    this.defaults = defaults;
    const status = registerDeviceStatus(key, capabilities.status as DeviceStatusOptions | undefined);
    const battery = registerDeviceBattery(key, capabilities.battery as DeviceBatteryOptions | undefined);
    const rssi = registerDeviceRssi(key, capabilities.rssi as DeviceRssiOptions | undefined);
    const metrics = registerDeviceMetrics(key, capabilities.metrics as DeviceMetricOptions[] | undefined);
    runtime().registerTarget({
      target: key,
      key,
      provider: "matter",
      capabilities,
      display: {
        status,
        battery,
        rssi,
        metrics,
      },
    });
  }

  set(state: Record<string, unknown> | null, options: { layer?: LayerName; reason?: string } = {}) {
    const layer = options.layer ?? "automation";
    runtime().writeLayer(this.key, layer, {
      state,
      reason: options.reason ?? (layer === "automation" ? deviceState.__matterLayerActiveRuleName ?? undefined : undefined),
      writer: options.reason,
    });
    runtime().recordRuleOutput(this.key);
    runtime().enqueueApply(this.key);
  }

  auto(value: boolean | Record<string, unknown> | null | undefined) {
    const write = () => {
      this.set(normalizeAutoValue(value, this.defaults), { layer: "automation" });
    };
    write();
    return write;
  }

  endpoint(endpointId: number) {
    return {
      light: (name: string, capabilities: Record<string, unknown> = {}) =>
        new TargetDevice(`${this.key}.endpoint.${endpointId}.${name}`, {
          power: {
            path: `${endpointId}/6/0`,
            commands: {
              on: { endpoint: endpointId, cluster: 6, command: "On" },
              off: { endpoint: endpointId, cluster: 6, command: "Off" },
            },
          },
          level: {
            path: `${endpointId}/8/0`,
            command: { endpoint: endpointId, cluster: 8, command: "MoveToLevelWithOnOff" },
          },
          color: {
            endpoint: endpointId,
            cluster: 768,
          },
          ...capabilities,
        }),
    };
  }

  paddle(_direction: string) {
    const direction = _direction;
    const key = this.key;
    return {
      onSinglePress(handler: () => void) {
        runtime().registerEventHandler(`${key}.paddle.${direction}.singlePress`, handler);
      },
    };
  }
}

export class RemoteDevice extends TargetDevice {
  onInitialPress(button: number, handler: () => void) {
    runtime().registerEventHandler(`${this.key}.button.${button}.initialPress`, handler);
  }
}

export function eventAction(name: string, event: string, outputs: TargetId[]) {
  runtime().registerEventAction({ name, event, outputs });
}

export function activeLayer(target: TargetId) {
  const activeRuntime = runtime();
  const source = makeSource<ActiveLayerState>({
    key: target,
    property: "activeLayer",
    provider: "synthetic",
  });
  activeRuntime.registerSource(source);
  const surfaced = activeRuntime.surfaceLayer(target);
  activeRuntime.updateSource({
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
  return source;
}

export function rule(name: string, run: () => void) {
  runtime().registerInternalRule(name, run);
}

export class CoverDevice extends TargetDevice {
  open() {
    this.set({ position: "open" }, { layer: "automation" });
  }

  close() {
    this.set({ position: "closed" }, { layer: "automation" });
  }

  stop() {
    this.set({ motion: "stop" }, { layer: "automation" });
  }

  onPositionChange(handler: (position: unknown, update: SourceUpdate) => void) {
    runtime().registerSourceHandler(`${this.key}.position`, (update) => handler(update.value, update));
  }
}

export class CoverGroup {
  readonly state: Record<string, any> = {};
  constructor(readonly covers: CoverDevice[]) {}

  open() {
    for (const cover of this.covers) cover.open();
  }

  close() {
    for (const cover of this.covers) cover.close();
  }

  stop() {
    for (const cover of this.covers) cover.stop();
  }
}

export class ReadableDevice extends TargetDevice {
  private readonly sources = new Map<string, SourceRef>();

  addSource<T>(property: string, args: { path?: string; when?: unknown; encoding?: string } = {}) {
    const source = makeSource<T>({
      key: this.key,
      property,
      path: args.path,
      when: args.when,
      encoding: args.encoding,
    });
    this.sources.set(property, source);
    runtime().registerSource(source);
    Object.defineProperty(this, property, {
      enumerable: true,
      configurable: true,
      get: () => source.read(),
    });
  }
}

export function light(key: string, options: LightOptions = {}) {
  return new TargetDevice(key, withDefaultStatus(options, lightStatus()), { power: "on", ...(options.on ?? {}) });
}

export function switchDevice(key: string, options: Record<string, unknown> = {}) {
  return new TargetDevice(key, withDefaultStatus(options, lightStatus()), { power: "on" });
}

export function remote(key: string, options: Record<string, unknown> = {}) {
  return new RemoteDevice(key, options);
}

export function cover(key: string, options: Record<string, unknown> = {}) {
  return new CoverDevice(key, withDefaultStatus(options, {
    property: "position",
    path: String((options.position as { path?: string } | undefined)?.path ?? "1/258/14"),
    encoding: "matter-percent",
    values: {
      0: { label: "open", tone: "open" },
      100: { label: "closed", tone: "closed" },
    },
  }));
}

export function coverGroup(keysOrCovers: Array<string | CoverDevice>, options: { member?: (key: string) => CoverDevice } = {}) {
  const covers = keysOrCovers.map((item) =>
    typeof item === "string" ? (options.member ? options.member(item) : cover(item)) : item,
  );
  return new CoverGroup(covers);
}

export function contact(key: string, options: { open: { path?: string; when?: unknown } } & Record<string, unknown>) {
  const device = new ReadableDevice(key, withDefaultStatus(options, {
    property: "displayStatus",
    path: String(options.open.path ?? "1/69/0"),
    when: options.open.when,
    values: {
      true: { label: "open", tone: "open" },
      false: { label: "closed", tone: "closed" },
    },
  }));
  device.addSource<boolean>("open", options.open);
  return device as ReadableDevice & { open: boolean };
}

export function matterDevice(
  key: string,
  options: {
    presence?: { path?: string; when?: unknown };
    lux?: { path?: string; encoding?: string };
    status?: DeviceStatusOptions;
    battery?: DeviceBatteryOptions;
    rssi?: DeviceRssiOptions;
    metrics?: DeviceMetricOptions[];
  } & Record<string, unknown>,
) {
  const device = new ReadableDevice(key, options);
  if (options.presence) {
    device.addSource<boolean>("presence", options.presence);
  }
  if (options.lux) {
    device.addSource<number>("lux", options.lux);
  }
  return device as ReadableDevice & { presence: boolean; lux: number };
}

function registerDeviceStatus(key: string, status?: DeviceStatusOptions): DeviceStatusDisplay | undefined {
  if (!status?.path) return undefined;
  const property = status.property ?? "status";
  const source = makeSource({
    key,
    property,
    path: status.path,
    encoding: status.encoding,
    when: status.when,
  });
  runtime().registerSource(source);
  return {
    source: source.source,
    label: status.label,
    values: status.values,
  };
}

function registerDeviceBattery(key: string, battery?: DeviceBatteryOptions): DeviceBatteryDisplay | undefined {
  if (!battery?.path) return undefined;
  const source = makeSource({
    key,
    property: battery.property ?? "battery",
    path: battery.path,
    encoding: battery.encoding ?? "matter-battery-percent",
  });
  runtime().registerSource(source);
  return {
    source: source.source,
    label: battery.label,
  };
}

function registerDeviceRssi(key: string, rssi?: DeviceRssiOptions): DeviceRssiDisplay | undefined {
  if (!rssi?.path) return undefined;
  const source = makeSource({
    key,
    property: rssi.property ?? "rssi",
    path: rssi.path,
    encoding: rssi.encoding,
  });
  runtime().registerSource(source);
  return {
    source: source.source,
    label: rssi.label,
    unit: rssi.unit ?? "dBm",
  };
}

function registerDeviceMetrics(key: string, metrics: DeviceMetricOptions[] | undefined): DeviceMetricDisplay[] | undefined {
  if (!metrics?.length) return undefined;
  return metrics.map((metric) => {
    const source = makeSource({
      key,
      property: metric.property,
      path: metric.path,
      encoding: metric.encoding,
    });
    runtime().registerSource(source);
    return {
      source: source.source,
      label: metric.label,
      unit: metric.unit,
    };
  });
}

function withDefaultStatus<T extends Record<string, unknown>>(options: T, status: DeviceStatusOptions): T {
  return {
    status,
    ...options,
  };
}

function lightStatus(): DeviceStatusOptions {
  return {
    property: "power",
    path: "1/6/0",
    values: {
      true: { label: "on", tone: "on" },
      false: { label: "off", tone: "off" },
    },
  };
}

function normalizeAutoValue(value: boolean | Record<string, unknown> | null | undefined, defaults: Record<string, unknown>) {
  if (value === true) {
    return { ...defaults };
  }
  if (value === false) {
    return { power: "off" };
  }
  if (value == null) {
    return null;
  }
  return value;
}
