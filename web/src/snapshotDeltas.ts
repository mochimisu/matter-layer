export type Snapshot = {
  sources: Array<{ source: string; key: string; property: string; value: unknown; since?: number; updatedAt?: number }>;
  signals: Array<{ id: string; value: unknown; deps: string[]; initialized: boolean; lastRunAt?: number }>;
  targets: Array<{
    target: string;
    key: string;
    capabilities?: Record<string, unknown>;
    display?: {
      status?: {
        source: string;
        label?: string;
        value?: unknown;
        since?: number;
        values?: Record<string, string | { label: string; tone?: string }>;
      };
      battery?: {
        source: string;
        label?: string;
        value?: unknown;
        since?: number;
        updatedAt?: number;
      };
      rssi?: {
        source: string;
        label?: string;
        unit?: string;
        value?: unknown;
        since?: number;
        updatedAt?: number;
      };
      metrics?: Array<{
        source: string;
        label: string;
        unit?: string;
        value?: unknown;
        since?: number;
        updatedAt?: number;
      }>;
    };
  }>;
  rules: Array<{ name: string; enabled: boolean; deps: string[]; outputs?: string[]; lastRunAt?: number; lastError?: string }>;
  layers: Array<{
    target: string;
    layers: Array<{ layer: string; output: { state: unknown; reason?: string; expiresAt?: number } }>;
    surfaced: { layer: string; output: { state: unknown; reason?: string } } | null;
  }>;
  commands?: Array<unknown>;
  matterLog?: Array<{
    id: number;
    at: number;
    direction: "received" | "sent";
    kind: "source" | "command";
    subject: string;
    key?: string;
    property?: string;
    value?: unknown;
    state?: Record<string, unknown> | null;
    reason?: string;
    ok?: boolean;
    error?: string;
  }>;
  events: string[];
  eventActions?: Array<{ name: string; event: string; outputs: string[]; lastRunAt?: number }>;
  pulses?: Array<{ source: string; lastTriggeredAt: number; duration: number }>;
  providers: Array<{
    name: string;
    status: {
      enabled?: boolean;
      connected?: boolean;
      nodeCount?: number;
      lastMessageAt?: number;
      resolved?: Array<{ key: string; nodeId: number; label?: string; mac?: string; available?: boolean; offlineSince?: number; rssi?: number; lastProbeAt?: number }>;
      unresolvedSources?: string[];
      unresolvedTargets?: string[];
    } | null;
  }>;
};

export type SnapshotDelta =
  | { type: "source"; source: Snapshot["sources"][number]; log?: NonNullable<Snapshot["matterLog"]>[number] }
  | { type: "signal"; signal: Snapshot["signals"][number]; pulses?: Snapshot["pulses"] }
  | { type: "rule"; rule: Snapshot["rules"][number] }
  | { type: "layer"; layer: Snapshot["layers"][number] }
  | { type: "provider"; provider: Snapshot["providers"][number] }
  | { type: "command"; command: unknown; log?: NonNullable<Snapshot["matterLog"]>[number] };

export type LiveMessage =
  | { type: "snapshot"; seq: number; snapshot: Snapshot }
  | { type: "delta"; seq: number; delta: SnapshotDelta }
  | { type: "event"; seq: number };

export function applySnapshotDelta(snapshot: Snapshot, delta: SnapshotDelta): Snapshot {
  switch (delta.type) {
    case "source":
      return {
        ...snapshot,
        sources: replaceItem(snapshot.sources, (source) => source.source === delta.source.source, delta.source),
        matterLog: appendLog(snapshot.matterLog, delta.log),
      };
    case "signal":
      return {
        ...snapshot,
        signals: replaceItem(snapshot.signals, (signal) => signal.id === delta.signal.id, delta.signal),
        pulses: delta.pulses ?? snapshot.pulses,
      };
    case "rule":
      return { ...snapshot, rules: replaceItem(snapshot.rules, (rule) => rule.name === delta.rule.name, delta.rule) };
    case "layer":
      return { ...snapshot, layers: replaceItem(snapshot.layers, (layer) => layer.target === delta.layer.target, delta.layer) };
    case "provider":
      return { ...snapshot, providers: replaceItem(snapshot.providers, (provider) => provider.name === delta.provider.name, delta.provider) };
    case "command":
      return {
        ...snapshot,
        commands: [...(snapshot.commands ?? []), delta.command].slice(-50),
        matterLog: appendLog(snapshot.matterLog, delta.log),
      };
  }
}

function appendLog(log: Snapshot["matterLog"], entry: NonNullable<Snapshot["matterLog"]>[number] | undefined) {
  if (!entry) return log;
  return [...(log ?? []), entry].slice(-200);
}

function replaceItem<T>(items: T[], matches: (item: T) => boolean, next: T) {
  const index = items.findIndex(matches);
  return index === -1 ? [...items, next] : items.map((item, itemIndex) => (itemIndex === index ? next : item));
}
