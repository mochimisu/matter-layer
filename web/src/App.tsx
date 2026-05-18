import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Blinds, DoorClosed, DoorOpen, UserRound, UserRoundCheck } from "lucide-react";
import { buildFlowLanes, layoutFlowLanes, type FlowNodeModel } from "./flowGraph";
import { applySnapshotDelta, type LiveMessage, type Snapshot } from "./snapshotDeltas";
import "./style.css";

type AppTab = "devices" | "details" | "graph";

function tabFromLocation(): AppTab {
  const tab = new URLSearchParams(location.search).get("tab");
  return tab === "graph" || tab === "details" ? tab : "devices";
}

function roomFromLocation() {
  return new URLSearchParams(location.search).get("room") ?? "all";
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<AppTab>(() => tabFromLocation());
  const [roomFilter, setRoomFilter] = useState(() => roomFromLocation());

  async function load() {
    const response = await fetch("/api/snapshot");
    setSnapshot(await response.json());
  }

  useEffect(() => {
    let active = true;
    let lastSeq = 0;
    async function loadIfActive() {
      const response = await fetch("/api/snapshot");
      const next = await response.json();
      if (active) setSnapshot(next);
    }
    void loadIfActive();
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events`);
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as LiveMessage;
        if (message.seq && lastSeq && message.seq !== lastSeq + 1) {
          lastSeq = message.seq;
          void loadIfActive();
          return;
        }
        if (message.seq) lastSeq = message.seq;
        if (message.type === "snapshot") {
          if (active) setSnapshot(message.snapshot);
          return;
        }
        if (message.type === "delta") {
          setSnapshot((current) => (current ? applySnapshotDelta(current, message.delta) : current));
          return;
        }
        void loadIfActive();
      } catch {
        void loadIfActive();
      }
    };
    ws.onclose = () => {
      if (active) void loadIfActive();
    };
    return () => {
      active = false;
      ws.close();
    };
  }, []);

  useEffect(() => {
    function syncUrlState() {
      setTab(tabFromLocation());
      setRoomFilter(roomFromLocation());
    }
    window.addEventListener("popstate", syncUrlState);
    return () => window.removeEventListener("popstate", syncUrlState);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("graph-page-active", tab === "graph");
    return () => document.body.classList.remove("graph-page-active");
  }, [tab]);

  function selectTab(next: AppTab) {
    setTab(next);
    const url = new URL(location.href);
    if (next === "devices") {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", next);
    }
    history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function selectRoom(next: string) {
    setRoomFilter(next);
    const url = new URL(location.href);
    if (next === "all") {
      url.searchParams.delete("room");
    } else {
      url.searchParams.set("room", next);
    }
    history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function mutate(key: string, url: string, init: RequestInit) {
    setBusy(key);
    try {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(await response.text());
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function setOverride(target: string, state: Record<string, unknown>, ttl?: string) {
    await mutate(target, `/api/devices/${encodeURIComponent(target)}/web-override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, ttl, reason: ttl ? `Web override for ${ttl}` : "Web override" }),
    });
  }

  async function clearOverride(target: string) {
    await mutate(target, `/api/devices/${encodeURIComponent(target)}/web-override`, { method: "DELETE" });
  }

  async function setAutomation(name: string, enabled: boolean) {
    await mutate(name, `/api/automations/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  }

  async function toggleSource(source: string) {
    await mutate(source, `/api/test/source/${encodeURIComponent(source)}/toggle`, { method: "POST" });
  }

  async function forceApplyCurrent() {
    setBusy("force-apply");
    try {
      const response = await fetch("/api/apply-current", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: roomFilter }),
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setSnapshot(payload.snapshot);
    } finally {
      setBusy(null);
    }
  }

  const roomOptions = useMemo(() => roomNames(snapshot), [snapshot]);
  const visibleSnapshot = useMemo(() => filterSnapshot(snapshot, roomFilter), [snapshot, roomFilter]);
  const matter = snapshot?.providers.find((provider) => provider.name === "matter");
  const activeOverrides = visibleSnapshot?.layers.filter((layer) => layer.surfaced?.layer === "webOverride" || layer.surfaced?.layer === "override").length ?? 0;
  const disabledRules = visibleSnapshot?.rules.filter((rule) => !rule.enabled).length ?? 0;
  const drivenDevices = visibleSnapshot?.layers.filter((layer) => layer.surfaced).length ?? 0;
  const visibleResolvedBindings = matter?.status?.resolved?.filter((binding) => roomFilter === "all" || roomOf(binding.key) === roomFilter) ?? [];
  const visibleUnresolvedSources = matter?.status?.unresolvedSources?.filter((source) => roomFilter === "all" || roomOf(source) === roomFilter).length ?? 0;
  const visibleUnresolvedTargets = matter?.status?.unresolvedTargets?.filter((target) => roomFilter === "all" || roomOf(target) === roomFilter).length ?? 0;

  const graphRows = useMemo(() => {
    const deps = new Map<string, string[]>();
    for (const rule of visibleSnapshot?.rules ?? []) {
      for (const dep of rule.deps) {
        const list = deps.get(dep) ?? [];
        list.push(rule.name);
        deps.set(dep, list);
      }
    }
    return [...deps.entries()].slice(0, 28);
  }, [visibleSnapshot]);

  const tabs = [
    { id: "devices" as const, label: "Devices", title: "Devices" },
    { id: "details" as const, label: "Details", title: "Details" },
    { id: "graph" as const, label: "Graph", title: "Graph" },
  ];

  return (
    <main className={["min-h-screen bg-transparent text-gaia-ink", tab === "graph" ? "graph-page" : ""].join(" ")}>
      <header className="gaia-app-header">
        <div className="mx-auto max-w-[1560px] px-4">
          <div className="relative flex min-h-[58px] items-start justify-between gap-6 py-3">
            <div className="relative z-10">
              <h1 className="header-title">// matter-layer</h1>
              <div className="header-subtitle">Matter Control Plane</div>
            </div>
            <div className="header-summary">
              <div className="header-stats grid grid-cols-3 text-right text-xs font-black uppercase">
                <HeaderStat label="Sources" value={visibleSnapshot?.sources.length ?? 0} />
                <HeaderStat label="Devices" value={visibleSnapshot?.targets.length ?? 0} />
                <HeaderStat label="Rules" value={visibleSnapshot?.rules.length ?? 0} />
              </div>
              <label className="room-filter">
                <span>Room</span>
                <select value={roomFilter} onChange={(event) => selectRoom(event.target.value)}>
                  <option value="all">All</option>
                  {roomOptions.map((room) => (
                    <option key={room} value={room}>
                      {room}
                    </option>
                  ))}
                </select>
              </label>
              <button className="force-apply-button" disabled={busy === "force-apply"} onClick={() => void forceApplyCurrent()}>
                Force Apply Current
              </button>
            </div>
          </div>
          <nav className="header-tabs">
            {tabs.map((item) => (
              <button
                key={item.id}
                title={item.title}
                onClick={() => selectTab(item.id)}
                className={["header-tab", tab === item.id ? "header-tab-active" : ""].join(" ")}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <div className={["mx-auto grid max-w-[1560px] grid-cols-1 gap-3 px-4 py-3", tab === "details" ? "lg:grid-cols-[320px_1fr]" : ""].join(" ")}>
        {tab === "details" ? (
        <aside className="grid content-start gap-3">
          <section className="gaia-panel">
            <div className="gaia-panel-head border-l-4 border-l-gaia-cyan">
              <h2 className="gaia-title">Provider</h2>
              <StatusPill connected={matter?.status?.connected} enabled={matter?.status?.enabled} />
            </div>
            <div className="grid grid-cols-2 gap-px bg-gaia-line text-sm">
              <Stat label="Nodes" value={matter?.status?.nodeCount ?? 0} />
              <Stat label="Bindings" value={visibleResolvedBindings.length} />
              <Stat label="Unresolved" value={visibleUnresolvedSources + visibleUnresolvedTargets} tone="warn" />
              <Stat label="Overrides" value={activeOverrides} tone={activeOverrides ? "warn" : "ok"} />
            </div>
          </section>

          <section className="gaia-panel">
            <div className="gaia-panel-head border-l-4 border-l-gaia-purple">
              <h2 className="gaia-title">Automations</h2>
              <span className="gaia-chip">{disabledRules} disabled</span>
            </div>
            <div className="max-h-[58vh] overflow-auto">
              {visibleSnapshot?.rules.map((rule) => (
                <div key={rule.name} className="gaia-row">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-black">{rule.name}</div>
                      <div className="text-xs text-gaia-muted">
                        {rule.deps.length} deps · {rule.outputs?.length ?? 0} outputs · {formatRunTime(rule.lastRunAt)}
                      </div>
                    </div>
                    <button className="gaia-button" disabled={busy === rule.name} onClick={() => void setAutomation(rule.name, !rule.enabled)}>
                      {rule.enabled ? "Disable" : "Enable"}
                    </button>
                  </div>
                  {rule.lastError ? <div className="border-l-4 border-l-gaia-red bg-red-50 px-2 py-1 text-xs text-gaia-red">{rule.lastError}</div> : null}
                </div>
              ))}
            </div>
          </section>
        </aside>
        ) : null}

        <div className="grid content-start gap-3">
          {tab === "details" ? (
            <>
          <section className="grid gap-2 md:grid-cols-4">
            <Metric label="Matter" value={matter?.status?.connected ? "Live" : matter?.status?.enabled === false ? "Disabled" : "Offline"} accent="cyan" />
            <Metric label="Driven Devices" value={drivenDevices} accent="orange" />
            <Metric label="Source Events" value={visibleSnapshot?.sources.length ?? 0} accent="green" />
            <Metric label="Debug Events" value={visibleSnapshot?.events.length ?? 0} accent="yellow" />
          </section>

          <section className="gaia-panel">
            <div className="gaia-panel-head border-l-4 border-l-gaia-orange">
              <h2 className="gaia-title">Devices</h2>
              <span className="gaia-chip">{visibleSnapshot?.targets.length ?? 0} targets</span>
            </div>
            <div className="grid gap-px bg-gaia-line md:grid-cols-2 xl:grid-cols-4">
              {visibleSnapshot?.targets.map((target) => {
                const layer = visibleSnapshot.layers.find((item) => item.target === target.target);
                return (
                  <article key={target.target} className="device-card" data-active={Boolean(layer?.surfaced)}>
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-black">{target.key}</div>
                        <LayerLine layer={layer?.surfaced} />
                      </div>
                      <LayerBadge layer={layer?.surfaced?.layer} />
                    </div>
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      <button className="gaia-button" disabled={busy === target.target} onClick={() => void setOverride(target.target, { power: "on" }, "30m")}>
                        On
                      </button>
                      <button className="gaia-button" disabled={busy === target.target} onClick={() => void setOverride(target.target, { power: "off" }, "30m")}>
                        Off
                      </button>
                      <button className="gaia-button" disabled={busy === target.target} onClick={() => void clearOverride(target.target)}>
                        Clear
                      </button>
                    </div>
                    {layer?.layers.length ? (
                      <div className="space-y-0.5 border-t border-gaia-line pt-1.5 text-xs">
                        {layer.layers.map((item) => (
                          <div key={item.layer} className="flex justify-between gap-2">
                            <span className="font-bold">{item.layer}</span>
                            <span className="truncate text-gaia-muted">{item.output.reason ?? JSON.stringify(item.output.state)}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="grid gap-3 xl:grid-cols-2">
            <DataPanel title="Sources" accent="green" count={visibleSnapshot?.sources.length ?? 0}>
              {visibleSnapshot?.sources.map((source) => (
                <div key={source.source} className="gaia-row flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold">{source.source}</div>
                    <code className="text-xs text-gaia-muted">{JSON.stringify(source.value)} · since {formatRunTime(source.since)}</code>
                  </div>
                  <button className="gaia-button" disabled={busy === source.source} onClick={() => void toggleSource(source.source)}>
                    Toggle
                  </button>
                </div>
              ))}
            </DataPanel>

            <DataPanel title="Graph" accent="purple" count={graphRows.length}>
              {graphRows.map(([source, rules]) => (
                <div key={source} className="gaia-row">
                  <div className="truncate text-sm font-bold">{source}</div>
                  <div className="truncate text-xs text-gaia-muted">{rules.join(" → ")}</div>
                </div>
              ))}
            </DataPanel>
          </section>

          <DataPanel title="Matter Bindings" accent="cyan" count={visibleResolvedBindings.length}>
            <div className="grid md:grid-cols-2">
              {visibleResolvedBindings.map((binding) => (
                <div key={binding.key} className="gaia-row flex justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-bold">{binding.key}</span>
                  <span className="text-right text-xs text-gaia-muted">{binding.label ?? binding.mac ?? "unlabeled"} · {binding.nodeId}</span>
                </div>
              ))}
            </div>
          </DataPanel>
            </>
          ) : tab === "devices" ? (
            <DevicesOverview
              snapshot={visibleSnapshot}
              matter={matter}
              activeOverrides={activeOverrides}
              drivenDevices={drivenDevices}
              busy={busy}
              onSetOverride={setOverride}
              onClearOverride={clearOverride}
            />
          ) : (
            <GraphView snapshot={visibleSnapshot} />
          )}
        </div>
      </div>
    </main>
  );
}

function GraphView({ snapshot }: { snapshot: Snapshot | null }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    distance: number;
    center: { x: number; y: number };
    startView: { x: number; y: number; scale: number };
  } | null>(null);
  const previousNodeValuesRef = useRef(new Map<string, boolean>());
  const [view, setView] = useState({ x: 18, y: 18, scale: 0.88 });
  const [now, setNow] = useState(Date.now());
  const [nodeChanges, setNodeChanges] = useState<Record<string, { value: boolean; activeUntil: number; fadeUntil: number }>>({});
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, []);
  const sources = snapshot?.sources ?? [];
  const signals = snapshot?.signals ?? [];
  const eventActions = snapshot?.eventActions ?? [];
  const pulseSources = (snapshot?.pulses ?? []).map((pulse) => {
    const activeUntil = pulse.lastTriggeredAt + pulse.duration + 5000;
    return {
      source: pulse.source,
      key: pulse.source,
      property: "pulse",
      value: now <= pulse.lastTriggeredAt + pulse.duration ? "active" : "recent",
      since: pulse.lastTriggeredAt,
      activeUntil,
      fadeUntil: activeUntil + 5000,
    };
  });
  const rules = [
    ...(snapshot?.rules ?? []),
    ...eventActions.map((action) => ({
      name: action.name,
      enabled: true,
      deps: [action.event],
      outputs: action.outputs,
      lastRunAt: action.lastRunAt,
    })),
  ];
  const layers = snapshot?.layers ?? [];
  const eventSources = eventActions.map((action) => ({
    source: action.event,
    key: action.event,
    property: "event",
    value: action.lastRunAt ? "pressed" : "idle",
    since: action.lastRunAt,
    activeUntil: action.lastRunAt ? action.lastRunAt + 5000 : undefined,
    fadeUntil: action.lastRunAt ? action.lastRunAt + 10000 : undefined,
  }));
  const sourceById = new Map([...sources, ...eventSources, ...pulseSources].map((source) => [source.source, source]));
  const signalById = new Map(signals.map((signal) => [signal.id, signal]));
  const layerByTarget = new Map(layers.map((layer) => [layer.target, layer]));
  const lanes = buildFlowLanes(rules, signalById, sourceById, layerByTarget, expandedNodeIds);
  const canvas = layoutFlowLanes(lanes);
  const boolSignature = canvas.nodes
    .filter((node) => typeof node.boolValue === "boolean")
    .map((node) => `${node.id}:${node.boolValue}`)
    .join("|");

  useEffect(() => {
    const changedAt = Date.now();
    const nextChanges: Record<string, { value: boolean; activeUntil: number; fadeUntil: number }> = {};
    let changed = false;

    for (const node of canvas.nodes) {
      if (typeof node.boolValue !== "boolean") continue;
      const previous = previousNodeValuesRef.current.get(node.id);
      previousNodeValuesRef.current.set(node.id, node.boolValue);
      if (previous !== undefined && previous !== node.boolValue) {
        nextChanges[node.id] = {
          value: node.boolValue,
          activeUntil: changedAt + 5000,
          fadeUntil: changedAt + 10000,
        };
        changed = true;
      }
    }

    if (!changed) return;
    setNodeChanges((current) => ({
      ...Object.fromEntries(Object.entries(current).filter(([, marker]) => marker.fadeUntil > changedAt)),
      ...nextChanges,
    }));
  }, [boolSignature]);

  function zoomBy(factor: number, origin: { x: number; y: number }) {
    setView((current) => {
      const scale = clamp(current.scale * factor, 0.35, 1.8);
      const canvasX = (origin.x - current.x) / current.scale;
      const canvasY = (origin.y - current.y) / current.scale;
      return {
        scale,
        x: origin.x - canvasX * scale,
        y: origin.y - canvasY * scale,
      };
    });
  }

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const viewportElement = viewport;
    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      event.stopPropagation();
      const bounds = viewportElement.getBoundingClientRect();
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      zoomBy(factor, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    }
    viewportElement.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewportElement.removeEventListener("wheel", handleWheel);
  }, []);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) {
      pinchRef.current = pinchState(pointersRef.current, view, viewportRef.current);
      dragRef.current = null;
      return;
    }
    if (pointersRef.current.size === 1) {
      dragRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: view.x,
        startY: view.y,
      };
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const currentPinch = pinchState(pointersRef.current, pinchRef.current.startView, viewportRef.current);
      if (!currentPinch) return;
      const scale = clamp(pinchRef.current.startView.scale * (currentPinch.distance / pinchRef.current.distance), 0.35, 1.8);
      const canvasX = (pinchRef.current.center.x - pinchRef.current.startView.x) / pinchRef.current.startView.scale;
      const canvasY = (pinchRef.current.center.y - pinchRef.current.startView.y) / pinchRef.current.startView.scale;
      setView({
        scale,
        x: currentPinch.center.x - canvasX * scale,
        y: currentPinch.center.y - canvasY * scale,
      });
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((current) => ({
      ...current,
      x: drag.startX + event.clientX - drag.x,
      y: drag.startY + event.clientY - drag.y,
    }));
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
    if (pointersRef.current.size === 1) {
      const [entry] = pointersRef.current.entries();
      if (entry) {
        const [pointerId, point] = entry;
        dragRef.current = {
          pointerId,
          x: point.x,
          y: point.y,
          startX: view.x,
          startY: view.y,
        };
      }
    }
  }

  function toggleNode(id: string) {
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <section className="graph-full">
      <div
          ref={viewportRef}
          className="flow-viewport"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
        <div
          className="flow-transform"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            width: canvas.width,
            height: canvas.height,
          }}
        >
          <div className="flow-canvas" style={{ width: canvas.width, height: canvas.height }}>
            <svg className="pointer-events-none absolute inset-0" width={canvas.width} height={canvas.height}>
              {canvas.edges.map((edge) => {
                const d = referenceTangledPath(edge.points);
                return (
                  <g key={edge.id} className="flow-edge">
                    <path
                      d={d}
                      fill="none"
                      stroke="#ededeb"
                      strokeWidth="6"
                      opacity="0.96"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke={edge.color}
                      strokeWidth="2.35"
                      opacity="0.98"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </g>
                );
              })}
            </svg>
            {canvas.nodes.map((node) => (
              <FlowNode key={node.id} node={node} now={now} stateChange={nodeChanges[node.id]} onToggle={() => toggleNode(node.id)} />
            ))}
            <div className="flow-corner top-0 left-0" />
            <div className="flow-corner bottom-0 right-0 rotate-180" />
          </div>
        </div>
        <div className="flow-hud">
          Drag to pan · Wheel to zoom
        </div>
      </div>
    </section>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pinchState(
  pointers: Map<number, { x: number; y: number }>,
  startView: { x: number; y: number; scale: number },
  viewport: HTMLDivElement | null,
) {
  const bounds = viewport?.getBoundingClientRect();
  const points = [...pointers.values()].slice(0, 2);
  if (!bounds || points.length < 2) return null;
  const [first, second] = points;
  const firstLocal = { x: first.x - bounds.left, y: first.y - bounds.top };
  const secondLocal = { x: second.x - bounds.left, y: second.y - bounds.top };
  return {
    distance: Math.hypot(secondLocal.x - firstLocal.x, secondLocal.y - firstLocal.y),
    center: {
      x: (firstLocal.x + secondLocal.x) / 2,
      y: (firstLocal.y + secondLocal.y) / 2,
    },
    startView,
  };
}

function referenceTangledPath(points: Array<{ x: number; y: number }>) {
  const [first, ...rest] = points;
  if (!first) return "";
  if (points.length < 3) return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}`;
  const source = points[0];
  const target = points[points.length - 1];
  const bundle = points[2] ?? points[1];
  const direction = target.y >= source.y ? 1 : -1;
  const verticalGap = Math.abs(target.y - source.y);
  const horizontalIn = Math.max(0, bundle.x - source.x);
  const horizontalOut = Math.max(0, target.x - bundle.x);
  const c2 = Math.max(2, Math.min(32, horizontalIn / 2, verticalGap / 2));
  const c1 = Math.max(2, Math.min(32, horizontalOut / 2, verticalGap / 2));
  if (verticalGap < 4 || c1 < 3 || c2 < 3) {
    return `M ${source.x} ${source.y} L ${bundle.x} ${source.y} L ${target.x} ${target.y}`;
  }
  const sourceSweep = direction > 0 ? 1 : 0;
  const targetSweep = direction > 0 ? 0 : 1;
  return [
    `M ${source.x} ${source.y}`,
    `L ${bundle.x - c2} ${source.y}`,
    `A ${c2} ${c2} 90 0 ${sourceSweep} ${bundle.x} ${source.y + direction * c2}`,
    `L ${bundle.x} ${target.y - direction * c1}`,
    `A ${c1} ${c1} 90 0 ${targetSweep} ${bundle.x + c1} ${target.y}`,
    `L ${target.x} ${target.y}`,
  ].join(" ");
}

function roomOf(id: string) {
  return id.split(".")[0] ?? id;
}

function roomNames(snapshot: Snapshot | null) {
  if (!snapshot) return [];
  const rooms = new Set<string>();
  for (const source of snapshot.sources) rooms.add(roomOf(source.source));
  for (const target of snapshot.targets) rooms.add(roomOf(target.target));
  for (const rule of snapshot.rules) rooms.add(roomOf(rule.name));
  for (const action of snapshot.eventActions ?? []) rooms.add(roomOf(action.name));
  return [...rooms].sort((left, right) => left.localeCompare(right));
}

function DevicesOverview({
  snapshot,
  matter,
  activeOverrides,
  drivenDevices,
  busy,
  onSetOverride,
  onClearOverride,
}: {
  snapshot: Snapshot | null;
  matter: Snapshot["providers"][number] | undefined;
  activeOverrides: number;
  drivenDevices: number;
  busy: string | null;
  onSetOverride: (target: string, state: Record<string, unknown>, ttl?: string) => Promise<void>;
  onClearOverride: (target: string) => Promise<void>;
}) {
  const layersByTarget = new Map((snapshot?.layers ?? []).map((layer) => [layer.target, layer]));
  const sourceById = new Map((snapshot?.sources ?? []).map((source) => [source.source, source]));
  const resolvedByKey = new Map((matter?.status?.resolved ?? []).map((binding) => [binding.key, binding]));
  const rooms = groupTargetsByRoom(snapshot?.targets ?? []);
  return (
    <>
      <section className="grid gap-2 md:grid-cols-4">
        <Metric label="Matter" value={matter?.status?.connected ? "Live" : matter?.status?.enabled === false ? "Disabled" : "Offline"} accent="cyan" />
        <Metric label="Devices" value={visibleDeviceTargets(snapshot?.targets ?? []).length} accent="orange" />
        <Metric label="Driven" value={drivenDevices} accent="green" />
        <Metric label="Overrides" value={activeOverrides} accent="yellow" />
      </section>

      <div className="device-room-grid">
        {rooms.map(([room, targets]) => (
          <section key={room} className="gaia-panel device-room">
            <div className="gaia-panel-head border-l-4 border-l-gaia-cyan">
              <h2 className="gaia-title">{humanRoomName(room)}</h2>
              <span className="gaia-chip">{targets.length} devices</span>
            </div>
            <div className="device-table">
              {targets.map((target) => {
                const binding = resolvedByKey.get(target.key);
                const layer = layersByTarget.get(target.target);
                const status = deviceStatus(target, sourceById, layer);
                const battery = deviceBattery(target, sourceById);
                const metrics = deviceMetrics(target, sourceById);
                const vendor = String(target.capabilities?.vendor ?? "");
                const product = String(target.capabilities?.product ?? "");
                const label = binding?.label || target.key;
                const deviceInfo = [label, target.key, [vendor, product].filter(Boolean).join(" ")].filter(Boolean);
                const reason = layer?.surfaced?.output.reason ?? (layer?.surfaced ? formatValue(layer.surfaced.output.state) : "");
                return (
                  <article key={target.target} className="device-table-row">
                    <span>{status ? <DeviceStatusPill status={status} /> : null}</span>
                    <DeviceName label={label} details={deviceInfo} />
                    <span><LayerBadge layer={layer?.surfaced?.layer} /></span>
                    <span className="min-w-0 truncate text-xs text-gaia-muted">{reason}</span>
                    <span className="min-w-0 truncate text-xs text-gaia-muted">
                      {[...metrics, battery].filter((item) => item.label !== "—").map((item) => item.label).join(" · ") || "—"}
                    </span>
                    <span className="flex flex-wrap gap-1">
                      <button className="gaia-button" disabled={busy === target.target} onClick={() => void onSetOverride(target.target, { power: "on" }, "30m")}>
                        On
                      </button>
                      <button className="gaia-button" disabled={busy === target.target} onClick={() => void onSetOverride(target.target, { power: "off" }, "30m")}>
                        Off
                      </button>
                      <button className="gaia-button" disabled={busy === target.target} onClick={() => void onClearOverride(target.target)}>
                        Clear
                      </button>
                    </span>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function DeviceName({ label, details }: { label: string; details: string[] }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  function showTooltip(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 8,
      left: Math.min(rect.left, window.innerWidth - 320),
    });
  }

  return (
    <span className="device-name-cell">
      <span
        className="device-name-trigger"
        tabIndex={0}
        onMouseEnter={(event) => showTooltip(event.currentTarget)}
        onMouseLeave={() => setPosition(null)}
        onFocus={(event) => showTooltip(event.currentTarget)}
        onBlur={() => setPosition(null)}
      >
        {label}
      </span>
      {position ? (
        <span className="device-name-tooltip" style={{ top: position.top, left: position.left }}>
          {details.map((detail, index) => (
            <span key={`${detail}-${index}`} className={index === 0 ? "font-black text-gaia-ink" : ""}>
              {detail}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function groupTargetsByRoom(targets: Snapshot["targets"]) {
  const grouped = new Map<string, Snapshot["targets"]>();
  for (const target of visibleDeviceTargets(targets)) {
    const room = roomOf(target.target);
    const list = grouped.get(room) ?? [];
    list.push(target);
    grouped.set(room, list);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function visibleDeviceTargets(targets: Snapshot["targets"]) {
  return targets.filter((target) => !target.target.includes(".endpoint.") && !target.target.endsWith(".statusLed"));
}

function humanRoomName(room: string) {
  return room
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function deviceStatus(
  target: Snapshot["targets"][number],
  sourceById: Map<string, Snapshot["sources"][number]>,
  layer?: Snapshot["layers"][number],
) {
  const display = target.display?.status;
  const source = display?.source ? sourceById.get(display.source) : fallbackStatusSource(target, sourceById);
  const raw = source?.value ?? display?.value;
  const layeredState = layer?.surfaced?.output.state;
  const layered = layeredState && typeof layeredState === "object" ? layeredState as Record<string, unknown> : undefined;
  const layeredStatus = statusFromLayer(target, layered, raw);
  if (layeredStatus) return layeredStatus;
  if (target.capabilities?.buttons || target.capabilities?.events) return null;
  if (!display && !source) return null;
  const mapped = display?.values?.[String(raw)];
  if (typeof mapped === "string") return { label: mapped, tone: "unknown" };
  if (mapped) return withStatusIcon(target, { label: mapped.label, tone: mapped.tone ?? "unknown" }, source);
  if (raw === undefined) return null;
  if (source?.property === "presence") return withStatusIcon(target, raw ? { label: "active", tone: "active" } : { label: "clear", tone: "idle" }, source);
  if (source?.property === "open") return withStatusIcon(target, raw ? { label: "open", tone: "open" } : { label: "closed", tone: "closed" }, source);
  if (typeof raw === "boolean") return withStatusIcon(target, raw ? { label: "on", tone: "on" } : { label: "off", tone: "off" }, source);
  if (typeof raw === "number" && target.capabilities?.position) {
    if (raw <= 5) return withStatusIcon(target, { label: "open", tone: "open" });
    if (raw >= 95) return withStatusIcon(target, { label: "closed", tone: "closed" });
    return { label: `${Math.round(raw)}%`, tone: "active" };
  }
  return { label: formatValue(raw), tone: "unknown" };
}

function withStatusIcon(
  target: Snapshot["targets"][number],
  status: { label: string; tone?: string; icon?: ReactNode },
  source?: Snapshot["sources"][number],
) {
  const isDoor = source?.property === "open" || String(target.capabilities?.product ?? "").toLowerCase().includes("door");
  const isLight = Boolean(target.capabilities?.power);
  const isPresence = source?.property === "presence" || String(target.capabilities?.product ?? "").toLowerCase().includes("presence");
  const isCover = Boolean(target.capabilities?.position || target.capabilities?.commands);
  if (isDoor && status.label === "open") return { ...status, icon: <DoorOpen size={22} strokeWidth={2.2} aria-hidden="true" /> };
  if (isDoor && status.label === "closed") return { ...status, icon: <DoorClosed size={22} strokeWidth={2.2} aria-hidden="true" /> };
  if (isCover && status.label === "open") return { ...status, icon: "□" };
  if (isCover && status.label === "closed") return { ...status, icon: "■" };
  if (isCover && (status.label === "opening" || status.label === "closing" || status.label === "stopped")) {
    return { ...status, icon: <Blinds size={22} strokeWidth={2.2} aria-hidden="true" /> };
  }
  if (isLight && status.label === "on") return { ...status, icon: "●" };
  if (isLight && status.label === "off") return { ...status, icon: "○" };
  if (isPresence && status.label === "active") return { ...status, icon: <UserRoundCheck size={22} strokeWidth={2.2} aria-hidden="true" /> };
  if (isPresence && status.label === "clear") return { ...status, icon: <UserRound size={22} strokeWidth={2.2} aria-hidden="true" /> };
  return status;
}

function statusFromLayer(target: Snapshot["targets"][number], state: Record<string, unknown> | undefined, observed: unknown) {
  if (!state) return undefined;
  if (target.capabilities?.position || target.capabilities?.commands) {
    if (state.motion === "stop") return withStatusIcon(target, { label: "stopped", tone: "idle" });
    if (state.position === "open") {
      if (typeof observed === "number" && observed <= 5) return undefined;
      return withStatusIcon(target, { label: "opening", tone: "opening" });
    }
    if (state.position === "closed") {
      if (typeof observed === "number" && observed >= 95) return undefined;
      return withStatusIcon(target, { label: "closing", tone: "closing" });
    }
  }
  if ("power" in state) {
    return state.power === "off" || state.power === false
      ? withStatusIcon(target, { label: "off", tone: "off" })
      : withStatusIcon(target, { label: "on", tone: "on" });
  }
  return undefined;
}

function fallbackStatusSource(target: Snapshot["targets"][number], sourceById: Map<string, Snapshot["sources"][number]>) {
  const candidates = [
    `${target.key}.status`,
    `${target.key}.power`,
    `${target.key}.displayStatus`,
    `${target.key}.presence`,
    `${target.key}.open`,
    `${target.key}.position`,
  ];
  return candidates.map((source) => sourceById.get(source)).find(Boolean);
}

function deviceBattery(target: Snapshot["targets"][number], sourceById: Map<string, Snapshot["sources"][number]>) {
  const value = target.display?.battery?.source
    ? sourceById.get(target.display.battery.source)?.value ?? target.display.battery.value
    : target.display?.battery?.value;
  if (typeof value !== "number") return { label: "—", tone: "unknown" };
  const label = value <= 10 ? `${Math.round(value)}%` : value <= 100 ? `${Math.round(value)}%` : `${value.toFixed(1)}V`;
  return { label, tone: value <= 20 ? "warn" : "ok" };
}

function deviceMetrics(target: Snapshot["targets"][number], sourceById: Map<string, Snapshot["sources"][number]>) {
  return (target.display?.metrics ?? []).flatMap((metric) => {
    const value = sourceById.get(metric.source)?.value ?? metric.value;
    if (typeof value !== "number" && typeof value !== "string") return [];
    const formatted = typeof value === "number" ? `${Math.round(value)}${metric.unit ?? ""}` : `${value}${metric.unit ?? ""}`;
    return [{ label: `${metric.label}: ${formatted}`, tone: "ok" }];
  });
}

function DeviceStatusPill({ status }: { status: { label: string; tone?: string; icon?: ReactNode } }) {
  const classes: Record<string, string> = {
    on: "text-gaia-green",
    off: "text-gaia-muted",
    open: "text-gaia-green",
    closed: "text-gaia-muted",
    opening: "text-gaia-orange",
    closing: "text-gaia-orange",
    active: "text-gaia-green",
    idle: "text-gaia-muted",
    warn: "text-gaia-orange",
    unknown: "text-gaia-muted",
  };
  return <span className={`device-status ${classes[status.tone ?? "unknown"] ?? classes.unknown}`}>{status.icon ?? status.label}</span>;
}

function filterSnapshot(snapshot: Snapshot | null, room: string): Snapshot | null {
  if (!snapshot || room === "all") return snapshot;
  const inRoom = (id: string) => roomOf(id) === room;
  const sources = snapshot.sources.filter((source) => inRoom(source.source));
  const signals = snapshot.signals.filter((signal) => inRoom(signal.id));
  const targets = snapshot.targets.filter((target) => inRoom(target.target));
  const rules = snapshot.rules.filter((rule) => inRoom(rule.name));
  const layers = snapshot.layers.filter((layer) => inRoom(layer.target));
  const events = snapshot.events.filter(inRoom);
  const eventActions = (snapshot.eventActions ?? []).filter((action) => inRoom(action.name));
  return {
    ...snapshot,
    sources,
    signals,
    targets,
    rules,
    layers,
    events,
    eventActions,
  };
}

function FlowNode({
  node,
  now,
  stateChange,
  onToggle,
}: {
  node: FlowNodeModel;
  now: number;
  stateChange?: { value: boolean; activeUntil: number; fadeUntil: number };
  onToggle: () => void;
}) {
  const activity = timedOpacity(node.activeUntil, node.fadeUntil, now);
  const stateChangeActivity = timedOpacity(stateChange?.activeUntil, stateChange?.fadeUntil, now);
  const accent = activity > 0 ? "yellow" : stateChangeActivity > 0 ? (stateChange?.value ? "green" : "red") : undefined;
  const borderOpacity = Math.max(activity, stateChangeActivity);
  const activeUntil = activity > 0 ? node.activeUntil : stateChange?.activeUntil;
  const borderWidth = activeUntil && now <= activeUntil ? 2 : 1;
  return (
    <div
      className={`flow-node flow-node-${node.tone} ${node.expanded ? "flow-node-expanded" : ""}`}
      data-bool={typeof node.boolValue === "boolean" ? String(node.boolValue) : undefined}
      data-accent={accent}
      style={{ left: node.x, top: node.y, width: node.w, minHeight: node.h }}
      onClick={(event) => {
        event.stopPropagation();
        if (node.canExpand) onToggle();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      title={node.canExpand ? (node.expanded ? "Collapse" : "Expand") : undefined}
    >
      <div className="flow-node-type" />
      {accent ? <div className="flow-node-border" style={{ opacity: borderOpacity, padding: borderWidth }} /> : null}
      {activity > 0 ? <div className="flow-node-activity" style={{ opacity: activity }} /> : null}
      <div className={node.expanded ? "break-words text-sm font-black" : "truncate text-sm font-black"}>{node.title}</div>
      <div className={node.expanded ? "break-words text-xs text-gaia-muted" : "truncate text-xs text-gaia-muted"}>{node.meta}</div>
      {node.details ? (
        <div className={node.expanded ? "mt-1 break-words text-[0.68rem] leading-snug text-gaia-muted" : "mt-1 line-clamp-3 text-[0.68rem] leading-snug text-gaia-muted"}>
          {node.details}
        </div>
      ) : null}
      {node.canExpand ? <div className="flow-node-toggle">{node.expanded ? "Less" : "More"}</div> : null}
    </div>
  );
}

function timedOpacity(activeUntil: number | undefined, fadeUntil: number | undefined, now: number) {
  if (!activeUntil || !fadeUntil || now >= fadeUntil) return 0;
  if (now <= activeUntil) return 1;
  return Math.max(0, 1 - (now - activeUntil) / (fadeUntil - activeUntil));
}

function StatusPill({ connected, enabled }: { connected?: boolean; enabled?: boolean }) {
  const label = enabled === false ? "Disabled" : connected ? "Connected" : "Offline";
  const color = enabled === false ? "bg-gaia-yellow" : connected ? "bg-gaia-green" : "bg-gaia-red text-white";
  return <span className={`rounded-gaia border border-gaia-ink px-2 py-0.5 text-[0.68rem] font-black uppercase ${color}`}>{label}</span>;
}

function HeaderStat({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="header-stat">
      <div className="header-stat-label">{label}</div>
      <div className="header-stat-value">{String(value)}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: unknown; tone?: "ok" | "warn" }) {
  const color = tone === "warn" ? "text-gaia-orange" : tone === "ok" ? "text-gaia-green" : "text-gaia-ink";
  return (
    <div className="bg-gaia-tile p-2.5">
      <div className="text-[0.65rem] font-black uppercase text-gaia-muted">{label}</div>
      <div className={`text-xl font-black ${color}`}>{String(value)}</div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: unknown; accent: "cyan" | "orange" | "green" | "yellow" }) {
  const accents = {
    cyan: "border-t-gaia-cyan",
    orange: "border-t-gaia-orange",
    green: "border-t-gaia-green",
    yellow: "border-t-gaia-yellow",
  };
  return (
    <div className={`hud-card border-t-4 ${accents[accent]}`}>
      <div className="text-[0.65rem] font-black uppercase text-gaia-muted">{label}</div>
      <div className="mt-0.5 text-xl font-black">{String(value)}</div>
    </div>
  );
}

function DataPanel({ title, accent, count, children }: { title: string; accent: "cyan" | "green" | "purple"; count: number; children: ReactNode }) {
  const accents = {
    cyan: "border-l-gaia-cyan",
    green: "border-l-gaia-green",
    purple: "border-l-gaia-purple",
  };
  return (
    <section className="gaia-panel overflow-hidden">
      <div className={`gaia-panel-head border-l-4 ${accents[accent]}`}>
        <h2 className="gaia-title">{title}</h2>
        <span className="gaia-chip">{count}</span>
      </div>
      <div className="max-h-[420px] overflow-auto">{children}</div>
    </section>
  );
}

function LayerLine({ layer }: { layer?: { layer: string; output: { state: unknown; reason?: string } } | null }) {
  if (!layer) return null;
  return <div className="truncate text-xs text-gaia-muted">{layer.output.reason ?? JSON.stringify(layer.output.state)}</div>;
}

function LayerBadge({ layer }: { layer?: string }) {
  if (!layer) return null;
  const color = layer === "automation" ? "bg-gaia-green/30" : layer === "webOverride" || layer === "override" ? "bg-gaia-yellow" : "bg-gaia-paper";
  return <span className={`gaia-chip ${color}`}>{layer}</span>;
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

function shortDependency(
  dep: string,
  sourceById: Map<string, Snapshot["sources"][number]>,
  signalIds: Set<string>,
) {
  if (signalIds.has(dep)) return dep;
  const source = sourceById.get(dep);
  return source ? `${source.key}.${source.property}` : dep;
}

createRoot(document.getElementById("root")!).render(<App />);
