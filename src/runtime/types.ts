export type ProviderName = "matter" | "ha" | "timer" | "poll" | "synthetic" | "fake";

export type SourceId = string;
export type TargetId = string;

export type SourceUpdate = {
  source: SourceId;
  value: unknown;
  provider: ProviderName;
  observedAt: number;
  markUpdated?: boolean;
};

export type LayerName =
  | "safety"
  | "override"
  | "webOverride"
  | "scene"
  | "automation"
  | "default";

export type LayerOutput<T = Record<string, unknown>> = {
  state: T | null;
  layer?: LayerName;
  reason?: string;
  expiresAt?: number;
  writer?: string;
};

export type DesiredCommand = {
  target: TargetId;
  state: Record<string, unknown> | null;
  providerPreference: "matter-first" | "matter-only" | "ha-only";
  reason?: string;
};

export type CommandResult = {
  command: DesiredCommand;
  provider: ProviderName;
  dryRun: boolean;
  ok: boolean;
  error?: string;
  appliedAt: number;
};

export type MatterLogEntry = {
  id: number;
  at: number;
  direction: "received" | "sent";
  kind: "source" | "command" | "ping" | "probe" | "event";
  subject: string;
  key?: string;
  property?: string;
  value?: unknown;
  state?: Record<string, unknown> | null;
  reason?: string;
  ok?: boolean;
  error?: string;
  nodeId?: number;
  endpoint?: number;
  clusterId?: number;
  eventId?: number;
  eventName?: string;
  event?: string;
  elapsedMs?: number;
};

export type SourceBinding = {
  source: SourceId;
  key: string;
  property: string;
  provider: ProviderName;
  path?: string;
  when?: unknown;
  encoding?: string;
};

export type DeviceStatusTone = "on" | "off" | "open" | "closed" | "opening" | "closing" | "active" | "idle" | "warn" | "unknown";

export type DeviceStatusDisplay = {
  source: SourceId;
  label?: string;
  values?: Record<string, string | { label: string; tone?: DeviceStatusTone }>;
};

export type DeviceBatteryDisplay = {
  source: SourceId;
  label?: string;
};

export type DeviceMetricDisplay = {
  source: SourceId;
  label: string;
  unit?: string;
};

export type DeviceRssiDisplay = {
  source: SourceId;
  label?: string;
  unit?: string;
};

export type TargetBinding = {
  target: TargetId;
  key: string;
  provider: ProviderName;
  capabilities: Record<string, unknown>;
  display?: {
    status?: DeviceStatusDisplay;
    battery?: DeviceBatteryDisplay;
    rssi?: DeviceRssiDisplay;
    metrics?: DeviceMetricDisplay[];
  };
};

export type RuleRegistration = {
  name: string;
  run: () => void;
  enabled: boolean;
  deps: Set<SourceId>;
  outputs: Set<TargetId>;
  outputWrites: Map<TargetId, boolean>;
  lastRunAt?: number;
  lastError?: string;
};

export type SignalRegistration<T = unknown> = {
  id: string;
  compute: () => T;
  value: T | undefined;
  deps: Set<SourceId>;
  initialized: boolean;
  lastRunAt?: number;
};

export type RuntimeEvent =
  | { type: "source.changed"; update: SourceUpdate }
  | { type: "signal.changed"; id: string; value: unknown }
  | { type: "rule.run"; name: string }
  | { type: "device.event"; event: string }
  | { type: "provider.changed"; provider: ProviderName }
  | { type: "layer.changed"; target: string; layer: LayerName; output: LayerOutput | null; key?: string }
  | { type: "command"; result: CommandResult }
  | { type: "matter.log"; log: MatterLogEntry };

export type ProviderAdapter = {
  name: ProviderName;
  start?(runtime: Runtime): Promise<void> | void;
  stop?(): void;
  apply?(command: DesiredCommand): Promise<CommandResult>;
  snapshot?(): unknown;
};

export type Runtime = {
  updateSource(update: SourceUpdate): void;
  applyCommand(command: DesiredCommand): Promise<CommandResult>;
};
