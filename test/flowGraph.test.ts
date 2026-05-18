import { describe, expect, it } from "vitest";
import { buildFlowLanes, layoutFlowLanes, type FlowLayer, type FlowRule, type FlowSignal, type FlowSource } from "../web/src/flowGraph";

describe("flow graph model", () => {
  it("expands nested signal dependencies before rule outputs", () => {
    const sources: FlowSource[] = [
      { source: "room.primarySensor.presence", key: "room.primarySensor", property: "presence", value: true, since: Date.now() },
      { source: "room.zoneSensor.presence", key: "room.zoneSensor", property: "presence", value: false, since: Date.now() },
      { source: "room.showerSensor.presence", key: "room.showerSensor", property: "presence", value: false, since: Date.now() },
    ];
    const signals: FlowSignal[] = [
      { id: "room.zonePresence", value: false, deps: ["room.zoneSensor.presence"], lastRunAt: Date.now() },
      { id: "room.showerPresence", value: false, deps: ["room.showerSensor.presence"], lastRunAt: Date.now() },
      {
        id: "room.presence",
        value: true,
        deps: ["room.primarySensor.presence", "room.zonePresence", "room.showerPresence"],
        lastRunAt: Date.now(),
      },
    ];
    const rules: FlowRule[] = [
      {
        name: "room.lights",
        enabled: true,
        deps: ["room.presence"],
        outputs: ["room.main", "room.warm"],
        lastRunAt: Date.now(),
      },
    ];
    const layers: FlowLayer[] = [
      { target: "room.main", surfaced: { layer: "automation", output: { state: { power: "on" } } } },
      { target: "room.warm", surfaced: null },
    ];

    const lane = buildFlowLanes(
      rules,
      new Map(signals.map((signal) => [signal.id, signal])),
      new Map(sources.map((source) => [source.source, source])),
      new Map(layers.map((layer) => [layer.target, layer])),
    )[0];

    expect(lane.signalNodes.map((node) => node.title).sort()).toEqual([
      "room.presence",
      "room.showerPresence",
      "room.zonePresence",
    ]);
    expect(lane.sourceNodes.map((node) => node.title).sort()).toEqual([
      "room.primarySensor",
      "room.showerSensor",
      "room.zoneSensor",
    ]);
    expect(lane.edges).toEqual(
      expect.arrayContaining([
        { from: "room.lights:source:room.zoneSensor.presence", to: "room.lights:signal:room.zonePresence", tone: "source" },
        { from: "room.lights:source:room.showerSensor.presence", to: "room.lights:signal:room.showerPresence", tone: "source" },
        { from: "room.lights:signal:room.zonePresence", to: "room.lights:signal:room.presence", tone: "signal" },
        { from: "room.lights:signal:room.showerPresence", to: "room.lights:signal:room.presence", tone: "signal" },
        { from: "room.lights:signal:room.presence", to: "room.lights:rule", tone: "signal" },
        { from: "room.lights:rule", to: "result:room.main", tone: "result" },
        { from: "room.lights:rule", to: "result:room.warm", tone: "result" },
      ]),
    );

    const zoneSource = lane.sourceNodes.find((node) => node.title === "room.zoneSensor");
    const presenceSignal = lane.signalNodes.find((node) => node.title === "room.presence");
    const mainResult = lane.resultNodes.find((node) => node.title === "room.main");
    const warmResult = lane.resultNodes.find((node) => node.title === "room.warm");
    expect(zoneSource?.boolValue).toBe(false);
    expect(presenceSignal?.boolValue).toBe(true);
    expect(mainResult?.boolValue).toBe(true);
    expect(warmResult?.boolValue).toBe(false);
    expect(zoneSource?.meta).toContain("since");
    expect(presenceSignal?.meta).toContain("ran");

    const canvas = layoutFlowLanes([lane]);
    expect(canvas.edges.map((edge) => edge.id)).toContain(
      "room.lights:signal:room.showerPresence->room.lights:signal:room.presence",
    );
    expect(canvas.nodes.map((node) => node.title)).toEqual(
      expect.arrayContaining(["room.showerPresence", "room.zonePresence", "room.presence", "room.main", "room.warm"]),
    );
    expect(canvas.nodes.find((node) => node.title === "room.showerPresence")?.x).toBeLessThan(
      canvas.nodes.find((node) => node.title === "room.presence")?.x ?? 0,
    );
    const sourceX = canvas.nodes.find((node) => node.title === "room.primarySensor")?.x;
    expect(canvas.nodes.find((node) => node.title === "room.zoneSensor")?.x).toBe(sourceX);
    expect(canvas.nodes.find((node) => node.title === "room.showerSensor")?.x).toBe(sourceX);
    expect(sourceX).toBeLessThan(canvas.nodes.find((node) => node.title === "room.showerPresence")?.x ?? 0);
    const primaryToPresence = canvas.edges.find(
      (edge) => edge.id === "room.lights:source:room.primarySensor.presence->room.lights:signal:room.presence",
    );
    const showerPresenceX = canvas.nodes.find((node) => node.title === "room.showerPresence")?.x;
    expect(primaryToPresence?.points.some((point) => point.x === showerPresenceX)).toBe(false);
    expect(primaryToPresence?.points[0]?.y).toBeLessThan(canvas.nodes.find((node) => node.title === "room.zonePresence")?.y ?? 0);
    expect(canvas.nodes.find((node) => node.title === "room.presence")?.canExpand).toBe(false);
  });

  it("routes fan-in bundles with direction-aware lanes", () => {
    for (const count of [2, 3, 4, 5]) {
      const sourceFanIn = layoutForSourceFanIn(count);
      const sourceEdges = sourceFanIn.edges.filter((edge) => edge.id.includes(":source:") && edge.id.endsWith("->fan-in:signal:room.signal"));
      expect(sourceEdges).toHaveLength(count);
      expect(isAscending(sourceEdges.map((edge) => edge.from.y))).toBe(true);
      expect(isAscending(sourceEdges.map((edge) => edge.to.y))).toBe(true);
      expect(directionGroupsUseSeparateOrderedLanes(sourceEdges)).toBe(true);
      expect(oppositeDirectionExtremesShareLane(sourceEdges)).toBe(true);
      expect(minDirectionHorizontalLaneClearance(sourceEdges)).toBeGreaterThanOrEqual(1);

      const signalFanIn = layoutForSignalFanIn(count);
      const signalEdges = signalFanIn.edges.filter((edge) => edge.id.includes(":signal:room.inner") && edge.id.endsWith("->fan-in:signal:room.signal"));
      expect(signalEdges).toHaveLength(count);
      expect(isAscending(signalEdges.map((edge) => edge.from.y))).toBe(true);
      expect(isAscending(signalEdges.map((edge) => edge.to.y))).toBe(true);
      expect(directionGroupsUseSeparateOrderedLanes(signalEdges)).toBe(true);
      expect(oppositeDirectionExtremesShareLane(signalEdges)).toBe(true);
      expect(minDirectionHorizontalLaneClearance(signalEdges)).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps same-direction presence source fan-in on separate lanes", () => {
    const canvas = layoutPresenceFanIn();
    const edges = canvas.edges.filter((edge) => edge.id.endsWith("->room.lights:signal:room.presence"));
    expect(edges).toHaveLength(4);
    const sameDirectionEdges = edges.filter((edge) => edgeDirection(edge) === "down");
    expect(sameDirectionEdges.map((edge) => edge.id)).toEqual([
      "room.lights:source:room.presence.presence->room.lights:signal:room.presence",
      "room.lights:source:room.presenceFar.presence->room.lights:signal:room.presence",
    ]);
    expect(new Set(sameDirectionEdges.map((edge) => edge.viaX)).size).toBe(sameDirectionEdges.length);
  });

  it("keeps fan-out result lanes tightly bundled", () => {
    const canvas = layoutTestGraph(
      [{ source: "room.source.presence", key: "room.source", property: "presence", value: true, since: Date.now() }],
      [{ id: "room.signal", value: true, deps: ["room.source.presence"], lastRunAt: Date.now() }],
      ["room.top", "room.middle", "room.bottom"],
    );
    const resultEdges = canvas.edges.filter((edge) => edge.id.startsWith("fan-in:rule->result:"));
    expect(resultEdges).toHaveLength(3);
    const lanes = resultEdges.map((edge) => edge.viaX);
    expect(Math.max(...lanes) - Math.min(...lanes)).toBeLessThanOrEqual(6);
    expect(new Set(resultEdges.map((edge) => edge.color)).size).toBe(1);
  });

  it("shares target result nodes across automation lanes", () => {
    const sources: FlowSource[] = [
      { source: "room.sensor.presence", key: "room.sensor", property: "presence", value: true, since: Date.now() },
      { source: "room.main.paddle.up.singlePress", key: "room.main.paddle.up.singlePress", property: "event", value: "pressed", since: Date.now() },
    ];
    const signals: FlowSignal[] = [
      { id: "room.presence", value: true, deps: ["room.sensor.presence"], lastRunAt: Date.now() },
    ];
    const rules: FlowRule[] = [
      {
        name: "room.lights",
        enabled: true,
        deps: ["room.presence"],
        outputs: ["room.main"],
        lastRunAt: Date.now(),
      },
      {
        name: "room.main.override-on",
        enabled: true,
        deps: ["room.main.paddle.up.singlePress"],
        outputs: ["room.main", "room.main.endpoint.6.statusLed"],
        lastRunAt: Date.now(),
      },
    ];
    const layers: FlowLayer[] = [
      { target: "room.main", surfaced: { layer: "override", output: { state: { power: "on" }, reason: "Device Interaction" } } },
      { target: "room.main.endpoint.6.statusLed", surfaced: { layer: "override", output: { state: { power: "on", color: "green" } } } },
    ];

    const canvas = layoutFlowLanes(buildFlowLanes(
      rules,
      new Map(signals.map((signal) => [signal.id, signal])),
      new Map(sources.map((source) => [source.source, source])),
      new Map(layers.map((layer) => [layer.target, layer])),
    ));

    expect(canvas.nodes.filter((node) => node.id === "result:room.main")).toHaveLength(1);
    expect(canvas.edges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining([
        "room.lights:rule->result:room.main",
        "room.main.override-on:rule->result:room.main",
      ]),
    );
    expect(canvas.nodes.find((node) => node.id === "result:room.main")?.details).toContain("room.main.override-on");
    const resultEdges = canvas.edges.filter((edge) => edge.id.endsWith("->result:room.main"));
    expect(resultEdges).toHaveLength(2);
    expect(new Set(resultEdges.map((edge) => edge.viaX)).size).toBe(2);
    expect(resultEdges.map((edge) => edge.to.y)).toEqual([...resultEdges.map((edge) => edge.to.y)].sort((left, right) => left - right));
    const result = canvas.nodes.find((node) => node.id === "result:room.main");
    const producerCenters = ["room.lights:rule", "room.main.override-on:rule"].map((id) => {
      const node = canvas.nodes.find((candidate) => candidate.id === id);
      return (node?.y ?? 0) + (node?.h ?? 0) / 2;
    });
    expect(result?.y).toBeCloseTo((Math.min(...producerCenters) + Math.max(...producerCenters)) / 2 - (result?.h ?? 0) / 2);
  });

  it("colors wires from the source node", () => {
    const canvas = layoutForSourceFanIn(5);
    const edges = canvas.edges.filter((edge) => edge.id.includes(":source:") && edge.id.endsWith("->fan-in:signal:room.signal"));
    expect(edges).toHaveLength(5);
    expect(new Set(edges.map((edge) => edge.color)).size).toBeGreaterThan(1);
  });
});

function layoutForSourceFanIn(count: number) {
  const sources: FlowSource[] = Array.from({ length: count }, (_, index) => ({
    source: `room.source${index}.presence`,
    key: `room.source${index}`,
    property: "presence",
    value: index % 2 === 0,
    since: Date.now(),
  }));
  const signals: FlowSignal[] = [
    {
      id: "room.signal",
      value: true,
      deps: sources.map((source) => source.source),
      lastRunAt: Date.now(),
    },
  ];
  return layoutTestGraph(sources, signals);
}

function layoutForSignalFanIn(count: number) {
  const sources: FlowSource[] = Array.from({ length: count }, (_, index) => ({
    source: `room.source${index}.presence`,
    key: `room.source${index}`,
    property: "presence",
    value: index % 2 === 0,
    since: Date.now(),
  }));
  const innerSignals: FlowSignal[] = sources.map((source, index) => ({
    id: `room.inner${index}`,
    value: index % 2 === 0,
    deps: [source.source],
    lastRunAt: Date.now(),
  }));
  const signals: FlowSignal[] = [
    ...innerSignals,
    {
      id: "room.signal",
      value: true,
      deps: innerSignals.map((signal) => signal.id),
      lastRunAt: Date.now(),
    },
  ];
  return layoutTestGraph(sources, signals);
}

function layoutPresenceFanIn() {
  const sources: FlowSource[] = [
    { source: "room.presence.presence", key: "room.presence", property: "presence", value: true, since: Date.now() },
    { source: "room.presenceFar.presence", key: "room.presenceFar", property: "presence", value: true, since: Date.now() },
    { source: "room.door.open", key: "room.door", property: "open", value: false, since: Date.now() },
    { source: "pulse.room.presence.1", key: "pulse.room.presence.1", property: "pulse", value: "recent", since: Date.now() },
  ];
  const signals: FlowSignal[] = [
    {
      id: "room.presence",
      value: true,
      deps: sources.map((source) => source.source),
      lastRunAt: Date.now(),
    },
  ];
  return layoutTestGraph(sources, signals, ["room.main"], "room.lights", ["room.presence"]);
}

function layoutTestGraph(sources: FlowSource[], signals: FlowSignal[], outputs = ["room.output"], ruleName = "fan-in", ruleDeps = ["room.signal"]) {
  const rules: FlowRule[] = [
    {
      name: ruleName,
      enabled: true,
      deps: ruleDeps,
      outputs,
      lastRunAt: Date.now(),
    },
  ];
  const layers: FlowLayer[] = outputs.map((target) => ({ target, surfaced: { layer: "automation", output: { state: { power: "on" } } } }));
  const lanes = buildFlowLanes(
    rules,
    new Map(signals.map((signal) => [signal.id, signal])),
    new Map(sources.map((source) => [source.source, source])),
    new Map(layers.map((layer) => [layer.target, layer])),
  );
  return layoutFlowLanes(lanes);
}

function isAscending(values: number[]) {
  return values.every((value, index) => index === 0 || value >= values[index - 1]);
}

function directionGroupsUseSeparateOrderedLanes(edges: Array<{ from: { y: number }; to: { y: number }; viaX: number }>) {
  return ["down", "up", "flat"].every((direction) => {
    const group = edges.filter((edge) => edgeDirection(edge) === direction);
    const lanes = group.map((edge) => edge.viaX);
    if (lanes.length <= 1) return true;
    return direction === "up" ? isStrictlyAscending(lanes) : isStrictlyDescending(lanes);
  });
}

function isStrictlyAscending(values: number[]) {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function isStrictlyDescending(values: number[]) {
  return values.every((value, index) => index === 0 || value < values[index - 1]);
}

function oppositeDirectionExtremesShareLane(edges: Array<{ from: { y: number }; to: { y: number }; viaX: number }>) {
  const sorted = [...edges].sort((left, right) => left.from.y - right.from.y);
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  if (!top || !bottom || edgeDirection(top) === edgeDirection(bottom)) return true;
  return top.viaX === bottom.viaX;
}

function minDirectionHorizontalLaneClearance(edges: Array<{ from: { y: number }; to: { y: number }; points: Array<{ x: number; y: number }> }>) {
  const lanes = edges.flatMap((edge) => horizontalSegments(edge.points).map((segment) => ({ ...segment, direction: edgeDirection(edge) })));
  let clearance = Number.POSITIVE_INFINITY;
  for (let leftIndex = 0; leftIndex < lanes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < lanes.length; rightIndex += 1) {
      const left = lanes[leftIndex];
      const right = lanes[rightIndex];
      if (left.direction !== right.direction) continue;
      if (!rangesOverlap(left, right)) continue;
      clearance = Math.min(clearance, Math.abs(left.y - right.y));
    }
  }
  return clearance;
}

function edgeDirection(edge: { from: { y: number }; to: { y: number } }) {
  if (edge.to.y > edge.from.y + 0.001) return "down";
  if (edge.to.y < edge.from.y - 0.001) return "up";
  return "flat";
}

function horizontalSegments(points: Array<{ x: number; y: number }>) {
  const segments: Array<{ x1: number; x2: number; y: number }> = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    if (Math.abs(current.y - next.y) > 0.001) continue;
    segments.push({ x1: Math.min(current.x, next.x), x2: Math.max(current.x, next.x), y: current.y });
  }
  return segments;
}

function rangesOverlap(left: { x1: number; x2: number }, right: { x1: number; x2: number }) {
  return Math.max(left.x1, right.x1) < Math.min(left.x2, right.x2);
}
