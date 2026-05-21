import { describe, expect, it } from "vitest";
import { applySnapshotDelta, type Snapshot } from "../web/src/snapshotDeltas";

function baseSnapshot(): Snapshot {
  return {
    sources: [{ source: "room.sensor.presence", key: "room.sensor", property: "presence", value: false, since: 1 }],
    signals: [{ id: "room.presence", value: false, deps: ["room.sensor.presence"], initialized: true, lastRunAt: 1 }],
    targets: [{ target: "room.light", key: "room.light", capabilities: {} }],
    rules: [{ name: "room.light", enabled: true, deps: ["room.presence"], outputs: ["room.light"], lastRunAt: 1 }],
    layers: [{ target: "room.light", layers: [], surfaced: null }],
    commands: [],
    matterLog: [],
    events: [],
    providers: [],
  };
}

describe("snapshot deltas", () => {
  it("patches source, signal, rule, layer, and command changes without replacing the full snapshot", () => {
    let snapshot = baseSnapshot();

    snapshot = applySnapshotDelta(snapshot, {
      type: "source",
      source: { source: "room.sensor.presence", key: "room.sensor", property: "presence", value: true, since: 2 },
      log: { id: 1, at: 2, direction: "received", kind: "source", subject: "room.sensor.presence", key: "room.sensor", property: "presence", value: true },
    });
    snapshot = applySnapshotDelta(snapshot, {
      type: "signal",
      signal: { id: "room.presence", value: true, deps: ["room.sensor.presence"], initialized: true, lastRunAt: 2 },
    });
    snapshot = applySnapshotDelta(snapshot, {
      type: "rule",
      rule: { name: "room.light", enabled: true, deps: ["room.presence"], outputs: ["room.light"], lastRunAt: 2 },
    });
    snapshot = applySnapshotDelta(snapshot, {
      type: "layer",
      layer: {
        target: "room.light",
        layers: [{ layer: "automation", output: { state: { power: "on" }, reason: "room.light" } }],
        surfaced: { layer: "automation", output: { state: { power: "on" }, reason: "room.light" } },
      },
    });
    snapshot = applySnapshotDelta(snapshot, {
      type: "command",
      command: { command: { target: "room.light", state: { power: "on" } }, ok: true },
      log: { id: 2, at: 3, direction: "sent", kind: "command", subject: "room.light", key: "room.light", state: { power: "on" }, ok: true },
    });
    snapshot = applySnapshotDelta(snapshot, {
      type: "provider",
      provider: {
        name: "matter",
        status: {
          connected: true,
          resolved: [{ key: "room.light", nodeId: 123, available: false }],
        },
      },
    });

    expect(snapshot.sources[0].value).toBe(true);
    expect(snapshot.signals[0]).toMatchObject({ value: true, lastRunAt: 2 });
    expect(snapshot.rules[0]).toMatchObject({ lastRunAt: 2 });
    expect(snapshot.layers[0].surfaced?.output.state).toEqual({ power: "on" });
    expect(snapshot.commands).toHaveLength(1);
    expect(snapshot.matterLog).toHaveLength(2);
    expect(snapshot.providers[0].status?.resolved?.[0].available).toBe(false);
  });
});
