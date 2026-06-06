export type FlowSource = {
  source: string;
  key: string;
  property: string;
  value: unknown;
  since?: number;
  activeUntil?: number;
  fadeUntil?: number;
};

export type FlowSignal = {
  id: string;
  value: unknown;
  deps: string[];
  lastRunAt?: number;
};

export type FlowRule = {
  name: string;
  enabled: boolean;
  deps: string[];
  outputs?: string[];
  lastRunAt?: number;
};

export type FlowLayer = {
  target: string;
  surfaced: { layer: string; output: { state: unknown; reason?: string } } | null;
};

export type FlowNodeModel = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tone: "source" | "signal" | "rule" | "result" | "disabled";
  title: string;
  meta: string;
  details?: string;
  boolValue?: boolean;
  activeUntil?: number;
  fadeUntil?: number;
  expanded?: boolean;
  canExpand?: boolean;
};

export type FlowEdgeModel = {
  id: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  viaX: number;
  points: Array<{ x: number; y: number }>;
  junction?: { x: number; y: number };
  color: string;
  tone: "source" | "signal" | "result";
};

type FlowEdgeDefinition = { from: string; to: string; tone: "source" | "signal" | "result" };
type FlowDirection = "down" | "up" | "flat";
type LaneSlot = { index: number; count: number };

export type FlowLane = {
  id: string;
  rule: FlowRule;
  sourceNodes: FlowNodeModel[];
  signalNodes: FlowNodeModel[];
  ruleNode: FlowNodeModel;
  resultNodes: FlowNodeModel[];
  edges: FlowEdgeDefinition[];
};

export type FlowColumnLabel = {
  id: string;
  label: string;
  x: number;
};

const GRAPH_COLUMNS = { source: 24, signal: 485 };
const SIGNAL_COLUMN_STEP = 360;
const RULE_COLUMN_GAP = 290;
const RESULT_COLUMN_GAP = 365;
const NODE_GAP = 14;
const LANE_PAD = 32;
const LANE_GAP = 12;
const HEADER_PAD = 54;
const SOURCE_SIGNAL_LANE_SPACING = 6;
const RESULT_LANE_SPACING = 6;
const DEFAULT_LANE_SPACING = 30;

export function buildFlowLanes(
  rules: FlowRule[],
  signalById: Map<string, FlowSignal>,
  sourceById: Map<string, FlowSource>,
  layerByTarget: Map<string, FlowLayer>,
  expandedNodeIds = new Set<string>(),
): FlowLane[] {
  return [...rules].sort(compareRulesForGraph).map((rule) => {
    const sourceNodeById = new Map<string, FlowNodeModel>();
    const signalNodeById = new Map<string, FlowNodeModel>();

    function addSourceNode(dep: string) {
      const source = sourceById.get(dep);
      if (!source || source.source === "time.tick") return;
      const width = 240;
      const meta = `${source.property}: ${formatValue(valueForDisplay(source.value))} · since ${formatRunTime(source.since)}`;
      const id = `${rule.name}:source:${dep}`;
      const canExpand = canExpandNode(width, source.key, meta);
      const expanded = canExpand && expandedNodeIds.has(id);
      sourceNodeById.set(dep, {
        id,
        x: 0,
        y: 0,
        w: width,
        h: estimateNodeHeight(width, source.key, meta, undefined, expanded, canExpand),
        tone: "source",
        title: source.key,
        meta,
        boolValue: typeof source.value === "boolean" ? source.value : undefined,
        activeUntil: source.activeUntil,
        fadeUntil: source.fadeUntil,
        expanded,
        canExpand,
      });
    }

    function addSignalNode(dep: string, seen = new Set<string>()) {
      const signal = signalById.get(dep);
      if (!signal || seen.has(dep)) return;
      seen.add(dep);
      const width = 220;
      const meta = `${formatValue(valueForDisplay(signal.value))} · ${signal.deps.length} deps · ran ${formatRunTime(signal.lastRunAt)}`;
      const id = `${rule.name}:signal:${signal.id}`;
      const canExpand = canExpandNode(width, signal.id, meta);
      const expanded = canExpand && expandedNodeIds.has(id);
      signalNodeById.set(dep, {
        id,
        x: 0,
        y: 0,
        w: width,
        h: estimateNodeHeight(width, signal.id, meta, undefined, expanded, canExpand),
        tone: "signal",
        title: signal.id,
        meta,
        boolValue: typeof signal.value === "boolean" ? signal.value : undefined,
        expanded,
        canExpand,
      });
      for (const signalDep of signal.deps) {
        if (signalById.has(signalDep)) {
          addSignalNode(signalDep, seen);
        } else {
          addSourceNode(signalDep);
        }
      }
    }

    for (const dep of rule.deps) {
      if (signalById.has(dep)) {
        addSignalNode(dep);
      } else {
        addSourceNode(dep);
      }
    }

    const sourceNodes = [...sourceNodeById.values()];
    const signalNodes = [...signalNodeById.values()];
    const ruleWidth = 230;
    const ruleMeta = `${formatRunTime(rule.lastRunAt)} · ${rule.outputs?.length ?? 0} outputs`;
    const ruleDetails = rule.deps.join(" / ");
    const ruleNodeId = `${rule.name}:rule`;
    const ruleCanExpand = canExpandNode(ruleWidth, rule.name, ruleMeta, ruleDetails);
    const ruleExpanded = ruleCanExpand && expandedNodeIds.has(ruleNodeId);
    const ruleNode: FlowNodeModel = {
      id: ruleNodeId,
      x: 0,
      y: 0,
      w: ruleWidth,
      h: estimateNodeHeight(ruleWidth, rule.name, ruleMeta, ruleDetails, ruleExpanded, ruleCanExpand),
      tone: rule.enabled ? "rule" : "disabled",
      title: rule.name,
      meta: ruleMeta,
      details: ruleDetails,
      expanded: ruleExpanded,
      canExpand: ruleCanExpand,
    };
    const resultNodes = (rule.outputs ?? []).map((target) => {
      const surfaced = layerByTarget.get(target)?.surfaced;
      const state = surfaced?.output.state;
      const width = 250;
      const meta = surfaced ? `${surfaced.layer}: ${formatValue(state)}` : "no active layer";
      const details = surfaced?.output.reason;
      const id = `result:${target}`;
      const canExpand = canExpandNode(width, target, meta, details);
      const expanded = canExpand && expandedNodeIds.has(id);
      return {
        id,
        x: 0,
        y: 0,
        w: width,
        h: estimateNodeHeight(width, target, meta, details, expanded, canExpand),
        tone: "result" as const,
        title: target,
        meta,
        details,
        boolValue: resultBoolValue(state),
        expanded,
        canExpand,
      };
    });

    const edges: FlowLane["edges"] = [];
    for (const signal of signalNodes) {
      const signalId = signal.id.split(":signal:")[1];
      const deps = signalById.get(signalId)?.deps ?? [];
      for (const dep of deps) {
        if (sourceNodeById.has(dep)) {
          edges.push({ from: `${rule.name}:source:${dep}`, to: signal.id, tone: "source" });
        }
        if (signalNodeById.has(dep)) {
          edges.push({ from: `${rule.name}:signal:${dep}`, to: signal.id, tone: "signal" });
        }
      }
      if (rule.deps.includes(signalId)) {
        edges.push({ from: signal.id, to: ruleNode.id, tone: "signal" });
      }
    }
    for (const dep of rule.deps) {
      if (signalById.has(dep)) continue;
      if (sourceNodeById.has(dep)) {
        edges.push({ from: `${rule.name}:source:${dep}`, to: ruleNode.id, tone: "source" });
      }
    }
    for (const result of resultNodes) {
      edges.push({ from: ruleNode.id, to: result.id, tone: "result" });
    }

    return {
      id: rule.name,
      rule,
      sourceNodes,
      signalNodes,
      ruleNode,
      resultNodes,
      edges,
    };
  });
}

export function layoutFlowLanes(lanes: FlowLane[]) {
  const nodes: FlowNodeModel[] = [];
  const laneBands: Array<{ id: string; title: string; y: number; height: number }> = [];
  const resultNodesById = new Map<string, FlowNodeModel>();
  const resultProducersById = new Map<string, string[]>();
  const columnLabels: FlowColumnLabel[] = [
    { id: "source", label: "Sources", x: GRAPH_COLUMNS.source },
    { id: "signal", label: "Signals", x: GRAPH_COLUMNS.signal },
  ];
  const edges: FlowEdgeModel[] = [];
  const edgeDefinitions: FlowEdgeDefinition[] = [];
  const positions = new Map<string, FlowNodeModel>();
  let cursorY = HEADER_PAD + 38;
  let width = 1210;

  for (const lane of lanes) {
    for (const result of lane.resultNodes) {
      const producers = resultProducersById.get(result.id) ?? [];
      producers.push(lane.rule.name);
      resultProducersById.set(result.id, producers);
    }
  }

  for (const lane of lanes) {
    const newResultNodes = lane.resultNodes.flatMap((result) => {
      const existing = resultNodesById.get(result.id);
      if (existing) {
        mergeResultNode(existing, result, resultProducersById.get(result.id) ?? []);
        return [];
      }
      mergeResultNode(result, result, resultProducersById.get(result.id) ?? []);
      resultNodesById.set(result.id, result);
      return [result];
    });
    const signalLevels = signalLevelGroups(lane);
    const signalLevelById = new Map<string, number>();
    for (const [level, items] of signalLevels) {
      for (const item of items) {
        signalLevelById.set(item.id, level);
      }
    }
    const signalOrderById = new Map<string, number>();
    lane.signalNodes.forEach((node, index) => signalOrderById.set(node.id, index));
    const columnStacks = new Map<number, FlowNodeModel[]>();
    const columnTopOffsets = new Map<number, number>();
    for (const [level] of signalLevels) {
      const passthroughCount = sourcePassthroughCount(lane, signalLevelById, level);
      if (passthroughCount > 0) {
        columnTopOffsets.set(signalXForLevel(level), Math.min(240, passthroughCount * 72));
      }
    }
    for (const source of lane.sourceNodes) {
      addColumnNode(columnStacks, GRAPH_COLUMNS.source, source);
    }
    for (const [level, items] of signalLevels) {
      for (const item of items) {
        addColumnNode(columnStacks, signalXForLevel(level), item);
      }
    }
    sortColumnStacks(columnStacks, lane, signalLevelById, signalOrderById);
    const signalDepth = Math.max(...signalLevels.keys(), 0);
    const ruleX = signalXForLevel(signalDepth + 1) + 25;
    const resultX = ruleX + RESULT_COLUMN_GAP;
    width = Math.max(width, resultX + 280);
    const stackHeights = [
      ...[...columnStacks.entries()].map(([x, items]) => stackHeight(items) + (columnTopOffsets.get(x) ?? 0)),
      stackHeight([lane.ruleNode]),
      stackHeight(newResultNodes),
    ];
    const height = Math.max(116, LANE_PAD + Math.max(...stackHeights));
    laneBands.push({ id: lane.id, title: lane.id, y: cursorY - 14, height });

    for (const [x, items] of columnStacks) {
      placeStack(items, x, cursorY, height, columnTopOffsets.get(x) ?? 0);
    }
    lane.ruleNode.x = ruleX;
    lane.ruleNode.y = cursorY + Math.max(0, (height - lane.ruleNode.h) / 2) - 4;
    placeStack(newResultNodes, resultX, cursorY, height);

    for (const node of [...lane.sourceNodes, ...lane.signalNodes, lane.ruleNode, ...newResultNodes]) {
      nodes.push(node);
      positions.set(node.id, node);
    }
    for (const result of lane.resultNodes) {
      const shared = resultNodesById.get(result.id);
      if (shared) positions.set(result.id, shared);
    }
    edgeDefinitions.push(...lane.edges);
    cursorY += height + LANE_GAP;
  }
  placeSharedResultNodes([...resultNodesById.values()], resultProducersById, positions);
  edges.push(...routeEdges(edgeDefinitions, positions));

  const canvasHeight = Math.max(
    520,
    cursorY + 20,
    ...nodes.map((node) => node.y + node.h + 28),
  );

  return {
    width,
    height: canvasHeight,
    nodes,
    edges,
    lanes: laneBands,
    columnLabels: [
      ...columnLabels,
      { id: "rule", label: "Automations", x: Math.max(...nodes.filter((node) => node.tone === "rule" || node.tone === "disabled").map((node) => node.x), GRAPH_COLUMNS.signal + RULE_COLUMN_GAP) },
      { id: "result", label: "Results", x: Math.max(...nodes.filter((node) => node.tone === "result").map((node) => node.x), GRAPH_COLUMNS.signal + RULE_COLUMN_GAP + RESULT_COLUMN_GAP) },
    ],
  };

  function signalLevelGroups(lane: FlowLane) {
    const incomingSignals = new Map<string, string[]>();
    for (const edge of lane.edges) {
      if (edge.tone !== "signal" || !edge.from.includes(":signal:") || !edge.to.includes(":signal:")) {
        continue;
      }
      const list = incomingSignals.get(edge.to) ?? [];
      list.push(edge.from);
      incomingSignals.set(edge.to, list);
    }

    const levels = new Map<string, number>();
    const visiting = new Set<string>();
    function levelFor(nodeId: string): number {
      const existing = levels.get(nodeId);
      if (existing !== undefined) return existing;
      if (visiting.has(nodeId)) return 0;
      visiting.add(nodeId);
      const parents = incomingSignals.get(nodeId) ?? [];
      const level = parents.length === 0 ? 0 : Math.max(...parents.map(levelFor)) + 1;
      visiting.delete(nodeId);
      levels.set(nodeId, level);
      return level;
    }

    const grouped = new Map<number, FlowNodeModel[]>();
    for (const node of lane.signalNodes) {
      const level = levelFor(node.id);
      const list = grouped.get(level) ?? [];
      list.push(node);
      grouped.set(level, list);
    }
    return new Map([...grouped.entries()].sort(([left], [right]) => left - right));
  }

  function placeStack(items: FlowNodeModel[], x: number, y: number, laneHeight: number, topOffset = 0) {
    if (items.length === 0) return;
    const height = stackHeight(items) + topOffset;
    let itemY = y + Math.max(0, (laneHeight - height) / 2) - 4 + topOffset;
    for (const item of items) {
      item.x = x;
      item.y = itemY;
      itemY += item.h + NODE_GAP;
    }
  }

  function stackHeight(items: FlowNodeModel[]) {
    if (items.length === 0) return 0;
    return items.reduce((sum, item) => sum + item.h, 0) + (items.length - 1) * NODE_GAP;
  }

  function signalXForLevel(level: number) {
    return GRAPH_COLUMNS.signal + level * SIGNAL_COLUMN_STEP;
  }
}

function addColumnNode(columns: Map<number, FlowNodeModel[]>, x: number, node: FlowNodeModel) {
  const items = columns.get(x) ?? [];
  items.push(node);
  columns.set(x, items);
}

function compareRulesForGraph(left: FlowRule, right: FlowRule) {
  const leftTarget = primaryOutputTarget(left);
  const rightTarget = primaryOutputTarget(right);
  return leftTarget.localeCompare(rightTarget) || left.name.localeCompare(right.name);
}

function primaryOutputTarget(rule: FlowRule) {
  return (rule.outputs ?? []).find((output) => !output.includes(".endpoint.") && !output.endsWith(".statusLed"))
    ?? rule.outputs?.[0]
    ?? rule.name;
}

function mergeResultNode(target: FlowNodeModel, source: FlowNodeModel, producers: string[]) {
  target.meta = source.meta;
  target.boolValue = source.boolValue;
  target.activeUntil = source.activeUntil;
  target.fadeUntil = source.fadeUntil;
  const uniqueProducers = [...new Set(producers)];
  target.details = [
    source.details,
    uniqueProducers.length > 0 ? `outputs: ${uniqueProducers.join(" / ")}` : undefined,
  ].filter(Boolean).join("\n");
  target.canExpand = canExpandNode(target.w, target.title, target.meta, target.details);
  if (!target.canExpand) {
    target.expanded = false;
  }
  target.h = estimateNodeHeight(target.w, target.title, target.meta, target.details, target.expanded, target.canExpand);
}

function placeSharedResultNodes(
  resultNodes: FlowNodeModel[],
  resultProducersById: Map<string, string[]>,
  positions: Map<string, FlowNodeModel>,
) {
  const targets = resultNodes
    .map((node) => {
      const producers = resultProducersById.get(node.id) ?? [];
      const producerCenters = producers
        .map((producer) => positions.get(`${producer}:rule`))
        .filter((producer): producer is FlowNodeModel => Boolean(producer))
        .map((producer) => producer.y + producer.h / 2);
      const targetCenter = producerCenters.length > 0
        ? (Math.min(...producerCenters) + Math.max(...producerCenters)) / 2
        : node.y + node.h / 2;
      return {
        node,
        targetY: targetCenter - node.h / 2,
      };
    })
    .sort((left, right) => left.targetY - right.targetY || left.node.id.localeCompare(right.node.id));

  let previousBottom = -Infinity;
  for (const item of targets) {
    const y = Math.max(item.targetY, previousBottom + NODE_GAP);
    item.node.y = y;
    positions.set(item.node.id, item.node);
    previousBottom = y + item.node.h;
  }
}

function sortColumnStacks(
  columns: Map<number, FlowNodeModel[]>,
  lane: FlowLane,
  signalLevelById: Map<string, number>,
  signalOrderById: Map<string, number>,
) {
  for (const items of columns.values()) {
    items.sort((left, right) => nodeSortKey(left, lane, signalLevelById, signalOrderById) - nodeSortKey(right, lane, signalLevelById, signalOrderById));
  }
}

function nodeSortKey(
  node: FlowNodeModel,
  lane: FlowLane,
  signalLevelById: Map<string, number>,
  signalOrderById: Map<string, number>,
) {
  if (node.id.includes(":source:")) {
    const targets = lane.edges
      .filter((edge) => edge.from === node.id && edge.to.includes(":signal:"))
      .map((edge) => ({
        level: signalLevelById.get(edge.to) ?? 0,
        order: signalOrderById.get(edge.to) ?? 0,
      }));
    const deepest = targets.length ? Math.max(...targets.map((target) => target.level)) : 0;
    const firstOrder = targets.length ? Math.min(...targets.map((target) => target.order)) : 0;
    return deepest > 0 ? -1000 + firstOrder : firstOrder;
  }
  if (node.id.includes(":signal:")) {
    const level = signalLevelById.get(node.id) ?? 0;
    return level * 1000 + (signalOrderById.get(node.id) ?? 0);
  }
  return 0;
}

function sourcePassthroughCount(lane: FlowLane, signalLevelById: Map<string, number>, level: number) {
  return lane.edges.filter((edge) => {
    if (!edge.from.includes(":source:") || !edge.to.includes(":signal:")) return false;
    const targetLevel = signalLevelById.get(edge.to);
    return targetLevel !== undefined && targetLevel > level;
  }).length;
}

function routeEdges(edges: FlowEdgeDefinition[], positions: Map<string, FlowNodeModel>) {
  const edgesByTarget = groupedEdges(edges, "to");
  for (const [target, list] of edgesByTarget) {
    const targetNode = positions.get(target);
    list.sort((left, right) => edgeSourceY(left, positions) - edgeSourceY(right, positions) || edgePriority(left, targetNode) - edgePriority(right, targetNode));
  }

  const edgesBySource = groupedEdges(edges, "from");
  for (const list of edgesBySource.values()) {
    list.sort((left, right) => edgeTargetY(left, positions) - edgeTargetY(right, positions) || edgePriority(left, positions.get(left.to)) - edgePriority(right, positions.get(right.to)));
  }
  const targetSlotByEdge = edgeSlotIndexes(edgesByTarget);
  const sourceSlotByEdge = edgeSlotIndexes(edgesBySource);
  return edges.flatMap((edge): FlowEdgeModel[] => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return [];

    const targetGroup = edgesByTarget.get(edge.to) ?? [edge];
    const targetIndex = targetSlotByEdge.get(edge) ?? targetGroup.indexOf(edge);
    const targetCount = targetGroup.length;
    const sourceGroup = edgesBySource.get(edge.from) ?? [edge];
    const sourceIndex = sourceSlotByEdge.get(edge) ?? sourceGroup.indexOf(edge);
    const sourceCount = sourceGroup.length;
    const fromPort = {
      x: from.x + from.w + 8,
      y: from.y + from.h / 2 + (targetCount > 1 ? sourceFanInSourceOffset(edge, targetGroup, targetIndex) : portOffset(sourceIndex, sourceCount)),
    };
    const toPort = {
      x: to.x - 8,
      y: to.y + to.h / 2 + portOffset(targetIndex, targetCount),
    };
    const slot = targetCount > 1
      ? edge.to.startsWith("result:")
        ? { index: targetIndex, count: targetCount }
        : directedFanInLane(edge, targetGroup, positions)
      : directedFanOutLane(edge, sourceGroup, positions);
    const viaX = junctionXForEdge(edge, from, to, slot.index, slot.count);
    const junction = { x: viaX, y: junctionYForGroup(to, targetIndex, targetCount) };

    return [{
      id: `${edge.from}->${edge.to}`,
      from: fromPort,
      to: toPort,
      viaX,
      points: routeThroughJunction(fromPort, toPort, junction),
      junction,
      color: edgeColor(edge.tone, edge.from),
      tone: edge.tone,
    }];
  });
}

function groupedEdges(edges: FlowEdgeDefinition[], key: "from" | "to") {
  const grouped = new Map<string, FlowEdgeDefinition[]>();
  for (const edge of edges) {
    const list = grouped.get(edge[key]) ?? [];
    list.push(edge);
    grouped.set(edge[key], list);
  }
  return grouped;
}

function edgeSourceY(edge: FlowEdgeDefinition, positions: Map<string, FlowNodeModel>) {
  const source = positions.get(edge.from);
  return source ? source.y + source.h / 2 : 0;
}

function edgeTargetY(edge: FlowEdgeDefinition, positions: Map<string, FlowNodeModel>) {
  const target = positions.get(edge.to);
  return target ? target.y + target.h / 2 : 0;
}

function edgeSlotIndexes(groups: Map<string, FlowEdgeDefinition[]>) {
  const indexes = new Map<FlowEdgeDefinition, number>();
  for (const group of groups.values()) {
    group.forEach((edge, index) => indexes.set(edge, index));
  }
  return indexes;
}

function routeThroughJunction(from: { x: number; y: number }, to: { x: number; y: number }, junction: { x: number; y: number }) {
  return [
    from,
    { x: junction.x, y: from.y },
    junction,
    { x: to.x, y: junction.y },
    to,
  ].filter((point, index, points) => {
    const previous = points[index - 1];
    return !previous || Math.abs(previous.x - point.x) > 0.001 || Math.abs(previous.y - point.y) > 0.001;
  });
}

function junctionXForEdge(
  edge: FlowLane["edges"][number],
  from: FlowNodeModel,
  to: FlowNodeModel,
  bundleIndex: number,
  bundleCount: number,
) {
  const left = from.x + from.w;
  const right = to.x;
  const spacing = edge.to.includes(":signal:")
    ? SOURCE_SIGNAL_LANE_SPACING
    : edge.to.startsWith("result:")
      ? RESULT_LANE_SPACING
      : DEFAULT_LANE_SPACING;
  const snap = edge.to.includes(":signal:") || edge.to.startsWith("result:") ? 1 : 6;
  const separated = (base: number) => snapToGrid(base + bundleOffset(bundleIndex, bundleCount, spacing), snap);
  if (edge.from.includes(":source:") && edge.to.includes(":signal:")) {
    return separated(right - 116);
  }
  if (edge.from.includes(":signal:") && edge.to.includes(":signal:")) {
    return Math.max(snapToGrid(left + 18, 6), separated(right - 116));
  }
  if (edge.from.includes(":signal:") && edge.to.endsWith(":rule")) {
    return separated(right - 72);
  }
  if (edge.from.endsWith(":rule") && edge.to.startsWith("result:")) {
    return separated(right - 72);
  }
  return snapToGrid((left + right) / 2, 11);
}

function bundleOffset(index: number, total: number, spacing: number) {
  if (total <= 1) return 0;
  return (index - (total - 1) / 2) * spacing;
}

function directedFanInLane(edge: FlowEdgeDefinition, targetGroup: FlowEdgeDefinition[], positions: Map<string, FlowNodeModel>): LaneSlot {
  return directedBundleSlot(edge, targetGroup, (item) => verticalDirection(item, targetGroup, positions));
}

function directedFanOutLane(edge: FlowEdgeDefinition, sourceGroup: FlowEdgeDefinition[], positions: Map<string, FlowNodeModel>): LaneSlot {
  if (sourceGroup.length <= 1) return { index: 0, count: 1 };
  return directedBundleSlot(edge, sourceGroup, (item) => fanOutDirection(item, positions));
}

function directedBundleSlot(edge: FlowEdgeDefinition, group: FlowEdgeDefinition[], directionFor: (edge: FlowEdgeDefinition) => FlowDirection): LaneSlot {
  const ordered = [...group];
  const direction = directionFor(edge);
  const downEdges = ordered.filter((item) => directionFor(item) === "down");
  const upEdges = ordered.filter((item) => directionFor(item) === "up");
  const flatEdges = ordered.filter((item) => directionFor(item) === "flat");
  const directionalCount = Math.max(1, downEdges.length, upEdges.length);
  if (direction === "down") {
    return { index: directionalCount - 1 - downEdges.indexOf(edge), count: directionalCount };
  }
  if (direction === "up") {
    return { index: directionalCount - upEdges.length + upEdges.indexOf(edge), count: directionalCount };
  }
  return { index: Math.max(0, flatEdges.indexOf(edge)), count: Math.max(1, flatEdges.length) };
}

function fanOutDirection(edge: FlowEdgeDefinition, positions: Map<string, FlowNodeModel>): FlowDirection {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) return "flat";
  const fromY = from.y + from.h / 2;
  const toY = to.y + to.h / 2;
  if (toY > fromY + 0.001) return "down";
  if (toY < fromY - 0.001) return "up";
  return "flat";
}

function verticalDirection(edge: FlowEdgeDefinition, targetGroup: FlowEdgeDefinition[], positions: Map<string, FlowNodeModel>): FlowDirection {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) return "flat";
  const targetIndex = targetGroup.indexOf(edge);
  const fromY = from.y + from.h / 2 + sourceFanInSourceOffset(edge, targetGroup, targetIndex);
  const toY = to.y + to.h / 2 + portOffset(targetIndex, targetGroup.length);
  if (toY > fromY + 0.001) return "down";
  if (toY < fromY - 0.001) return "up";
  return "flat";
}

function sourceFanInSourceOffset(edge: FlowEdgeDefinition, targetGroup: FlowEdgeDefinition[], targetIndex: number) {
  if (!edge.from.includes(":source:")) return 0;
  const targetCount = targetGroup.length;
  const targetPortY = portOffset(targetIndex, targetCount);
  const sourceIndex = targetGroup.slice(0, targetIndex + 1).filter((item) => item.from.includes(":source:")).length - 1;
  const sourceCount = targetGroup.filter((item) => item.from.includes(":source:")).length;
  const sourceLaneY = portOffset(sourceIndex, sourceCount);
  if (Math.abs(targetPortY - sourceLaneY) >= 1) return 0;
  return sourceLaneY > targetPortY ? -1 : 1;
}

function edgePriority(edge: FlowEdgeDefinition, target?: FlowNodeModel) {
  if (edge.from.includes(":source:") && target?.id.includes(":signal:")) return 0;
  if (edge.from.includes(":signal:") && target?.id.includes(":signal:")) return 1;
  if (edge.from.includes(":signal:") && target?.id.endsWith(":rule")) return 2;
  if (edge.from.endsWith(":rule") && target?.id.startsWith("result:")) return 3;
  return 4;
}

function junctionYForGroup(to: FlowNodeModel, targetIndex: number, targetCount: number) {
  return to.y + to.h / 2 + portOffset(targetIndex, targetCount);
}

function edgeColor(tone: "source" | "signal" | "result", sourceId: string) {
  const palettes = {
    source: ["#19a86b", "#2484d6", "#d1861d", "#8a68df", "#16a6a0", "#c24f73", "#6f9e1f", "#b45c2e"],
    signal: ["#2e7bd8", "#8b6be8", "#1ba39a", "#c58b18", "#4e9d2b", "#c9547b", "#1f95c2", "#9b63c8"],
    result: ["#8d63e6", "#d36c22", "#269b70", "#bf517c", "#2577c7", "#a69222", "#7d73e6", "#c45a42"],
  };
  const colors = palettes[tone];
  return colors[hashString(sourceId) % colors.length];
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function portOffset(index: number, total: number) {
  if (total <= 1) return 0;
  return (index - (total - 1) / 2) * 4;
}

function snapToGrid(value: number, grid: number) {
  return Math.round(value / grid) * grid;
}

function formatRunTime(value?: number) {
  if (!value) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function formatValue(value: unknown) {
  if (value === undefined) return "unknown";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function valueForDisplay(value: unknown) {
  return value;
}

function resultBoolValue(state: unknown): boolean | undefined {
  if (state == null) return false;
  if (typeof state === "boolean") return state;
  if (typeof state !== "object") return undefined;
  const power = (state as Record<string, unknown>).power;
  if (power === "on" || power === true) return true;
  if (power === "off" || power === false) return false;
  return undefined;
}

function estimateNodeHeight(width: number, title: string, meta: string, details?: string, expanded = false, hasToggle = false) {
  const horizontalPadding = 20;
  const charsPerLine = Math.max(18, Math.floor((width - horizontalPadding) / 7.2));
  const titleLines = estimatedLines(title, charsPerLine, expanded ? 4 : 1);
  const metaLines = estimatedLines(meta, charsPerLine, expanded ? 8 : 1);
  const detailsLines = details ? estimatedLines(details, charsPerLine, expanded ? 6 : 3) : 0;
  const verticalPadding = 16;
  const detailsGap = detailsLines > 0 ? 4 : 0;
  const toggleHeight = hasToggle ? 19 : 0;
  const toggleGap = hasToggle ? 4 : 0;
  return verticalPadding + titleLines * 18 + metaLines * 16 + detailsGap + detailsLines * 14 + toggleGap + toggleHeight;
}

function canExpandNode(width: number, title: string, meta: string, details?: string) {
  const horizontalPadding = 20;
  const charsPerLine = Math.max(18, Math.floor((width - horizontalPadding) / 7.2));
  const titleLines = estimatedLines(title, charsPerLine, Number.POSITIVE_INFINITY);
  const metaLines = estimatedLines(meta, charsPerLine, Number.POSITIVE_INFINITY);
  const detailsLines = details ? estimatedLines(details, charsPerLine, Number.POSITIVE_INFINITY) : 0;
  return (
    titleLines > 2 ||
    metaLines > 2 ||
    detailsLines > 3
  );
}

function estimatedLines(text: string, charsPerLine: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let lines = 1;
  let current = 0;
  for (const word of words) {
    const length = word.length;
    if (current === 0) {
      current = length;
      continue;
    }
    if (current + 1 + length > charsPerLine) {
      lines += 1;
      current = length;
    } else {
      current += 1 + length;
    }
  }
  return Math.min(maxLines, lines);
}
