import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  DoorClosed,
  DoorOpen,
  Lightbulb,
  RefreshCw,
  UserRound,
  UserRoundCheck,
} from "lucide-react";
import { buildFlowLanes, layoutFlowLanes, type FlowNodeModel } from "./flowGraph";
import { applySnapshotDelta, type LiveMessage, type Snapshot } from "./snapshotDeltas";
import "./style.css";

type AppTab = "devices" | "details" | "graph" | "log";
type DeviceOpResult = { label: string; tone: "ok" | "bad"; title?: string };
type DeviceStatus = { label: string; tone?: string; icon?: ReactNode; since?: number };

function tabFromLocation(): AppTab {
  const tab = new URLSearchParams(location.search).get("tab");
  return tab === "graph" || tab === "details" || tab === "log" ? tab : "devices";
}

function roomFromLocation() {
  return new URLSearchParams(location.search).get("room") ?? "all";
}

function formatDeviceOpResult(result: unknown): DeviceOpResult {
  const data = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const failed = data.ok === false;
  const elapsed = typeof data.elapsedMs === "number" ? `${Math.round(data.elapsedMs)}ms` : "ok";
  return { label: failed ? "failed" : elapsed, tone: failed ? "bad" : "ok", title: formatValue(data.result ?? result) };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function logDeviceFromLocation() {
  return new URLSearchParams(location.search).get("device") ?? "all";
}

function logAutomationFromLocation() {
  return new URLSearchParams(location.search).get("automation") ?? "all";
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deviceOpResults, setDeviceOpResults] = useState<Record<string, DeviceOpResult>>({});
  const [tab, setTab] = useState<AppTab>(() => tabFromLocation());
  const [roomFilter, setRoomFilter] = useState(() => roomFromLocation());
  const [logDeviceFilter, setLogDeviceFilter] = useState(() => logDeviceFromLocation());
  const [logAutomationFilter, setLogAutomationFilter] = useState(() => logAutomationFromLocation());
  const [now, setNow] = useState(() => Date.now());
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");

  async function load() {
    const response = await fetch("/api/snapshot");
    setSnapshot(await response.json());
  }

  useEffect(() => {
    let active = true;
    let lastSeq = 0;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    async function loadIfActive() {
      const response = await fetch("/api/snapshot");
      const next = await response.json();
      if (active) setSnapshot(next);
    }
    function connect() {
      if (!active || !pageVisible) return;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events`);
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
        ws = null;
        if (!active || !pageVisible) return;
        void loadIfActive();
        reconnectTimer = window.setTimeout(connect, 1000);
      };
    }
    void loadIfActive();
    connect();
    return () => {
      active = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [pageVisible]);

  useEffect(() => {
    function syncUrlState() {
      setTab(tabFromLocation());
      setRoomFilter(roomFromLocation());
      setLogDeviceFilter(logDeviceFromLocation());
      setLogAutomationFilter(logAutomationFromLocation());
    }
    window.addEventListener("popstate", syncUrlState);
    return () => window.removeEventListener("popstate", syncUrlState);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("graph-page-active", tab === "graph");
    return () => document.body.classList.remove("graph-page-active");
  }, [tab]);

  useEffect(() => {
    if (!pageVisible) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [pageVisible]);

  useEffect(() => {
    function syncVisibility() {
      setPageVisible(document.visibilityState !== "hidden");
    }
    document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

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

  function selectLogDevice(next: string) {
    setLogDeviceFilter(next);
    const url = new URL(location.href);
    if (next === "all") {
      url.searchParams.delete("device");
    } else {
      url.searchParams.set("device", next);
    }
    history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function selectLogAutomation(next: string) {
    setLogAutomationFilter(next);
    const url = new URL(location.href);
    if (next === "all") {
      url.searchParams.delete("automation");
    } else {
      url.searchParams.set("automation", next);
    }
    history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function mutate(key: string, url: string, init: RequestInit) {
    setBusy(key);
    try {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      await load();
      return payload;
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

  async function setSource(source: string, value: unknown, ttl?: string) {
    await mutate(source, "/api/test/source", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, value, ttl }),
    });
  }

  async function clearSource(source: string) {
    await mutate(source, `/api/test/source/${encodeURIComponent(source)}/override`, { method: "DELETE" });
  }

  async function dispatchDeviceEvent(event: string) {
    await mutate(event, "/api/test/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    });
  }

  async function clearOverride(target: string) {
    await mutate(target, `/api/devices/${encodeURIComponent(target)}/web-override`, { method: "DELETE" });
  }

  async function pingDevice(target: string) {
    try {
      const payload = await mutate(`ping:${target}`, `/api/devices/${encodeURIComponent(target)}/matter-ping`, { method: "POST" });
      setDeviceOpResults((current) => ({ ...current, [`ping:${target}`]: formatDeviceOpResult(payload?.result) }));
    } catch (error) {
      setDeviceOpResults((current) => ({ ...current, [`ping:${target}`]: { label: "failed", tone: "bad", title: errorText(error) } }));
      throw error;
    }
  }

  async function probeDevice(target: string) {
    try {
      const payload = await mutate(`probe:${target}`, `/api/devices/${encodeURIComponent(target)}/matter-probe`, { method: "POST" });
      setDeviceOpResults((current) => ({ ...current, [`probe:${target}`]: formatDeviceOpResult(payload?.result) }));
    } catch (error) {
      setDeviceOpResults((current) => ({ ...current, [`probe:${target}`]: { label: "failed", tone: "bad", title: errorText(error) } }));
      throw error;
    }
  }

  async function refreshMatter() {
    await mutate("matter-refresh", "/api/matter/refresh", { method: "POST" });
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

  const roomOptions = useMemo(() => roomNames(snapshot), [snapshot]);
  const roomSnapshot = useMemo(() => filterSnapshot(snapshot, roomFilter), [snapshot, roomFilter]);
  const logDeviceOptions = useMemo(() => deviceFilterOptions(roomSnapshot), [roomSnapshot]);
  const logAutomationOptions = useMemo(() => automationFilterOptions(roomSnapshot), [roomSnapshot]);
  useEffect(() => {
    if (logDeviceFilter !== "all" && !logDeviceOptions.some((option) => option.value === logDeviceFilter)) {
      selectLogDevice("all");
    }
  }, [logDeviceFilter, logDeviceOptions]);
  useEffect(() => {
    if (logAutomationFilter !== "all" && !logAutomationOptions.some((option) => option.value === logAutomationFilter)) {
      selectLogAutomation("all");
    }
  }, [logAutomationFilter, logAutomationOptions]);
  const visibleSnapshot = roomSnapshot;
  const logSnapshot = useMemo(() => filterSnapshotByLogFilters(roomSnapshot, logDeviceFilter, logAutomationFilter), [roomSnapshot, logDeviceFilter, logAutomationFilter]);
  const matter = snapshot?.providers.find((provider) => provider.name === "matter");
  const activeOverrides = visibleSnapshot?.layers.filter((layer) => layer.surfaced?.layer === "webOverride" || layer.surfaced?.layer === "override").length ?? 0;
  const disabledRules = visibleSnapshot?.rules.filter((rule) => !rule.enabled).length ?? 0;
  const drivenDevices = visibleSnapshot?.layers.filter((layer) => layer.surfaced).length ?? 0;
  const visibleTargetKeys = new Set((visibleSnapshot?.targets ?? []).flatMap((target) => [target.key, target.target]));
  const visibleResolvedBindings = matter?.status?.resolved?.filter((binding) => visibleTargetKeys.has(binding.key) || (roomFilter === "all" || roomOf(binding.key) === roomFilter)) ?? [];
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
    { id: "log" as const, label: "Log", title: "Matter Log" },
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
              <div className="header-matter-state">
                <span>Matter</span>
                <StatusPill status={matter?.status} now={now} />
                <button
                  className="header-icon-button"
                  title="Refresh Matter snapshot"
                  aria-label="Refresh Matter snapshot"
                  disabled={busy === "matter-refresh"}
                  onClick={() => void refreshMatter()}
                >
                  <RefreshCw size={14} strokeWidth={2.6} />
                </button>
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
              <StatusPill status={matter?.status} now={now} />
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
              now={now}
              busy={busy}
              onSetOverride={setOverride}
              onSetSource={setSource}
              onClearOverride={clearOverride}
              onClearSource={clearSource}
              onDispatchEvent={dispatchDeviceEvent}
              onPingDevice={pingDevice}
              onProbeDevice={probeDevice}
              deviceOpResults={deviceOpResults}
            />
          ) : tab === "log" ? (
            <LogView
              snapshot={logSnapshot}
              deviceFilter={logDeviceFilter}
              automationFilter={logAutomationFilter}
              deviceOptions={logDeviceOptions}
              automationOptions={logAutomationOptions}
              onSelectDevice={selectLogDevice}
              onSelectAutomation={selectLogAutomation}
            />
          ) : (
            <GraphView snapshot={visibleSnapshot} pageVisible={pageVisible} />
          )}
        </div>
      </div>
    </main>
  );
}

function GraphView({ snapshot, pageVisible }: { snapshot: Snapshot | null; pageVisible: boolean }) {
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
    if (!pageVisible) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [pageVisible]);
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
  now,
  busy,
  onSetOverride,
  onSetSource,
  onClearOverride,
  onClearSource,
  onDispatchEvent,
  onPingDevice,
  onProbeDevice,
  deviceOpResults,
}: {
  snapshot: Snapshot | null;
  matter: Snapshot["providers"][number] | undefined;
  now: number;
  busy: string | null;
  onSetOverride: (target: string, state: Record<string, unknown>, ttl?: string) => Promise<void>;
  onSetSource: (source: string, value: unknown, ttl?: string) => Promise<void>;
  onClearOverride: (target: string) => Promise<void>;
  onClearSource: (source: string) => Promise<void>;
  onDispatchEvent: (event: string) => Promise<void>;
  onPingDevice: (target: string) => Promise<void>;
  onProbeDevice: (target: string) => Promise<void>;
  deviceOpResults: Record<string, DeviceOpResult>;
}) {
  const layersByTarget = new Map((snapshot?.layers ?? []).map((layer) => [layer.target, layer]));
  const sourceById = new Map((snapshot?.sources ?? []).map((source) => [source.source, source]));
  const resolvedByKey = new Map((matter?.status?.resolved ?? []).map((binding) => [binding.key, binding]));
  const rooms = groupTargetsByRoom(snapshot?.targets ?? []);
  let deviceRowIndex = 0;
  return (
    <section className="gaia-panel device-room">
      <div className="device-table">
        {rooms.map(([room, targets]) => (
          <Fragment key={room}>
            {(() => {
              const availability = roomAvailability(targets, resolvedByKey);
              return (
            <div className="device-room-head">
              <h2 className="device-room-title">{humanRoomName(room)}</h2>
              <div className="device-room-rule" aria-hidden="true" />
              <span className="device-room-count">{availability.available}/{availability.total}</span>
            </div>
              );
            })()}
            {targets.map((target) => {
              const binding = resolvedByKey.get(target.key) ?? resolvedByKey.get(target.target);
              const layer = layersByTarget.get(target.target);
              const status = deviceStatus(target, sourceById, layer);
              const health = matterHealth(matter, binding);
              const battery = deviceBattery(target, sourceById);
              const rssi = deviceRssi(target, sourceById, binding);
              const metrics = deviceMetrics(target, sourceById);
              const updatedAt = deviceLastUpdated(target, sourceById);
              const lastProbeAt = binding?.lastProbeAt;
              const vendor = String(target.capabilities?.vendor ?? "");
              const product = String(target.capabilities?.product ?? "");
              const label = binding?.label || target.key;
              const displayLabel = deviceDisplayLabel(label, target, room);
              const deviceInfo = [label, target.key, [vendor, product].filter(Boolean).join(" ")].filter(Boolean);
              const reason = layer?.surfaced?.output.reason ?? (layer?.surfaced ? formatValue(layer.surfaced.output.state) : "");
              const actions = deviceActions(target, sourceById, onSetOverride, onSetSource, onClearOverride, onClearSource, onDispatchEvent);
              const rowClass = deviceRowIndex++ % 2 === 0 ? "device-table-row device-table-row-striped" : "device-table-row";
              return (
                <article key={target.target} className={rowClass}>
                  <span>{status ? <DeviceStatusPill status={status} now={now} /> : null}</span>
                  <span className="device-name-with-health">
                    <DeviceName label={displayLabel} details={deviceInfo} offline={health.tone === "bad"} offlineSince={health.offlineSince} />
                  </span>
                  <span><LayerBadge layer={layer?.surfaced?.layer} /></span>
                  <span className="min-w-0 truncate text-xs text-gaia-muted">{reason}</span>
                  <span className="min-w-0 truncate text-xs text-gaia-muted">
                    {[...metrics, battery].filter((item) => item.label !== "—").map((item) => item.label).join(" · ") || "—"}
                  </span>
                  <span className="min-w-0 truncate text-xs font-bold text-gaia-muted" title={updatedAt ? new Date(updatedAt).toLocaleString() : undefined}>
                    {updatedAt ? formatRunTime(updatedAt) : "—"}
                  </span>
                  <span className="min-w-0 truncate text-xs font-bold text-gaia-muted" title={lastProbeAt ? new Date(lastProbeAt).toLocaleString() : undefined}>
                    {lastProbeAt ? formatRunTime(lastProbeAt) : "—"}
                  </span>
                  <span className={deviceRssiClass(rssi.tone)}>{rssi.label}</span>
                  <span className="device-actions">
                    {renderDeviceActions(actions, busy)}
                  </span>
                  <span className="device-ops">
                    <button
                      className="gaia-button device-op-button"
                      disabled={busy === `ping:${target.target}`}
                      title={deviceOpResults[`ping:${target.target}`]?.title}
                      onClick={() => void onPingDevice(target.target)}
                    >
                      <span>Ping</span>
                      {deviceOpResults[`ping:${target.target}`] ? (
                        <span className={`device-op-result device-op-result-${deviceOpResults[`ping:${target.target}`].tone}`}>
                          {deviceOpResults[`ping:${target.target}`].label}
                        </span>
                      ) : null}
                    </button>
                    <button
                      className="gaia-button device-op-button"
                      disabled={busy === `probe:${target.target}`}
                      title={deviceOpResults[`probe:${target.target}`]?.title}
                      onClick={() => void onProbeDevice(target.target)}
                    >
                      <span>Probe</span>
                      {deviceOpResults[`probe:${target.target}`] ? (
                        <span className={`device-op-result device-op-result-${deviceOpResults[`probe:${target.target}`].tone}`}>
                          {deviceOpResults[`probe:${target.target}`].label}
                        </span>
                      ) : null}
                    </button>
                  </span>
                </article>
              );
            })}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function roomAvailability(targets: Snapshot["targets"], resolvedByKey: Map<string, MatterResolvedBinding>) {
  let available = 0;
  for (const target of targets) {
    const binding = resolvedByKey.get(target.key) ?? resolvedByKey.get(target.target);
    if (binding?.available === true) available += 1;
  }
  return { available, total: targets.length };
}

function renderDeviceActions(actions: DeviceAction[], busy: string | null) {
  const rendered: ReactNode[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const durationAction = actions[index + 1];
    if (durationAction?.label === `${action.label} 30m`) {
      rendered.push(
        <span key={action.label} className="device-action-pair">
          <DeviceActionButton action={action} busy={busy} />
          <DeviceActionButton action={durationAction} busy={busy} displayLabel="30m" className="device-action-duration" />
        </span>,
      );
      index += 1;
    } else {
      rendered.push(<DeviceActionButton key={action.label} action={action} busy={busy} />);
    }
  }
  return rendered;
}

function DeviceActionButton({ action, busy, displayLabel, className = "" }: { action: DeviceAction; busy: string | null; displayLabel?: string; className?: string }) {
  return (
    <button
      className={className ? `gaia-button ${className}` : "gaia-button"}
      disabled={busy === action.busyKey}
      aria-label={displayLabel ? action.label : undefined}
      onClick={() => void action.run()}
    >
      {displayLabel ?? action.label}
    </button>
  );
}

function DeviceName({ label, details, offline, offlineSince }: { label: string; details: string[]; offline?: boolean; offlineSince?: number }) {
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
        <span className="min-w-0 truncate">{label}</span>
        {offline ? <span className="device-offline-dot" aria-label="Offline" /> : null}
      </span>
      {position ? (
        <span className="device-name-tooltip" style={{ top: position.top, left: position.left }}>
          {offline ? (
            <span className="device-name-tooltip-offline">
              {offlineSince ? `offline since ${formatRunTime(offlineSince)}` : "offline"}
            </span>
          ) : null}
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

function LogView({
  snapshot,
  deviceFilter,
  automationFilter,
  deviceOptions,
  automationOptions,
  onSelectDevice,
  onSelectAutomation,
}: {
  snapshot: Snapshot | null;
  deviceFilter: string;
  automationFilter: string;
  deviceOptions: Array<{ value: string; label: string }>;
  automationOptions: Array<{ value: string; label: string }>;
  onSelectDevice: (value: string) => void;
  onSelectAutomation: (value: string) => void;
}) {
  const entries = [...(snapshot?.matterLog ?? [])].sort((left, right) => right.at - left.at || right.id - left.id);
  return (
    <section className="gaia-panel overflow-hidden">
      <div className="gaia-panel-head border-l-4 border-l-gaia-purple">
        <h2 className="gaia-title">Matter Log</h2>
        <span className="gaia-chip">{entries.length} events</span>
      </div>
      <div className="log-filter-bar">
        <label className="log-filter">
          <span>Device</span>
          <select value={deviceFilter} onChange={(event) => onSelectDevice(event.target.value)}>
            <option value="all">All</option>
            {deviceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="log-filter">
          <span>Automation</span>
          <select value={automationFilter} onChange={(event) => onSelectAutomation(event.target.value)}>
            <option value="all">All</option>
            {automationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="matter-log-table">
        {entries.length ? entries.map((entry) => (
          <article key={entry.id} className="matter-log-row">
            <time className="matter-log-time" dateTime={new Date(entry.at).toISOString()}>
              {formatTimestamp(entry.at)}
            </time>
            <span className={entry.direction === "sent" ? "matter-log-direction matter-log-sent" : "matter-log-direction matter-log-received"}>
              {entry.direction}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-black">{entry.subject}</span>
              <span className="block truncate text-xs text-gaia-muted">{matterLogDetail(entry)}</span>
            </span>
            <span className={entry.ok === false ? "matter-log-status matter-log-error" : "matter-log-status"}>
              {entry.ok === false ? "error" : entry.kind}
            </span>
          </article>
        )) : (
          <div className="gaia-row text-sm text-gaia-muted">No Matter events captured yet.</div>
        )}
      </div>
    </section>
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

type DeviceAction = {
  label: string;
  busyKey: string;
  run: () => Promise<void>;
};

function deviceActions(
  target: Snapshot["targets"][number],
  sourceById: Map<string, Snapshot["sources"][number]>,
  onSetOverride: (target: string, state: Record<string, unknown>, ttl?: string) => Promise<void>,
  onSetSource: (source: string, value: unknown, ttl?: string) => Promise<void>,
  onClearOverride: (target: string) => Promise<void>,
  onClearSource: (source: string) => Promise<void>,
  onDispatchEvent: (event: string) => Promise<void>,
): DeviceAction[] {
  if (target.capabilities?.buttons || target.capabilities?.events) {
    return remoteActions(target, onDispatchEvent);
  }
  if (target.capabilities?.position || target.capabilities?.commands) {
    return [
      targetAction("Open", target, { position: "open" }, onSetOverride),
      targetAction("Open 30m", target, { position: "open" }, onSetOverride, "30m"),
      targetAction("Closed", target, { position: "closed" }, onSetOverride),
      targetAction("Closed 30m", target, { position: "closed" }, onSetOverride, "30m"),
      clearTargetAction(target, onClearOverride),
    ];
  }
  const presence = sourceById.get(`${target.key}.presence`);
  if (presence) {
    return booleanSourceActions(presence.source, onSetSource, onClearSource);
  }
  const door = sourceById.get(`${target.key}.open`);
  if (door) {
    return booleanSourceActions(door.source, onSetSource, onClearSource);
  }
  if (target.capabilities?.power) {
    return [
      targetAction("On", target, { power: "on" }, onSetOverride),
      targetAction("On 30m", target, { power: "on" }, onSetOverride, "30m"),
      targetAction("Off", target, { power: "off" }, onSetOverride),
      targetAction("Off 30m", target, { power: "off" }, onSetOverride, "30m"),
      clearTargetAction(target, onClearOverride),
    ];
  }
  return [];
}

function targetAction(
  label: string,
  target: Snapshot["targets"][number],
  state: Record<string, unknown>,
  onSetOverride: (target: string, state: Record<string, unknown>, ttl?: string) => Promise<void>,
  ttl?: string,
): DeviceAction {
  return {
    label,
    busyKey: target.target,
    run: () => onSetOverride(target.target, state, ttl),
  };
}

function clearTargetAction(target: Snapshot["targets"][number], onClearOverride: (target: string) => Promise<void>): DeviceAction {
  return {
    label: "Clear",
    busyKey: target.target,
    run: () => onClearOverride(target.target),
  };
}

function booleanSourceActions(
  source: string,
  onSetSource: (source: string, value: unknown, ttl?: string) => Promise<void>,
  onClearSource: (source: string) => Promise<void>,
): DeviceAction[] {
  return [
    sourceAction("On", source, true, onSetSource),
    sourceAction("On 30m", source, true, onSetSource, "30m"),
    sourceAction("Off", source, false, onSetSource),
    sourceAction("Off 30m", source, false, onSetSource, "30m"),
    clearSourceAction(source, onClearSource),
  ];
}

function sourceAction(
  label: string,
  source: string,
  value: unknown,
  onSetSource: (source: string, value: unknown, ttl?: string) => Promise<void>,
  ttl?: string,
): DeviceAction {
  return {
    label,
    busyKey: source,
    run: () => onSetSource(source, value, ttl),
  };
}

function clearSourceAction(source: string, onClearSource: (source: string) => Promise<void>): DeviceAction {
  return {
    label: "Clear",
    busyKey: source,
    run: () => onClearSource(source),
  };
}

function remoteActions(
  target: Snapshot["targets"][number],
  onDispatchEvent: (event: string) => Promise<void>,
): DeviceAction[] {
  const buttons = Object.keys((target.capabilities?.buttons as Record<string, unknown> | undefined) ?? {}).sort((left, right) => Number(left) - Number(right));
  return buttons.slice(0, 2).map((button, index) => {
    const event = `${target.key}.button.${button}.initialPress`;
    return {
      label: index === 0 ? "Top" : "Bottom",
      busyKey: event,
      run: () => onDispatchEvent(event),
    };
  });
}

function deviceDisplayLabel(label: string, target: Snapshot["targets"][number], room: string) {
  return stripRoomPrefix(label, room) || stripRoomPrefix(target.key, room) || label;
}

function stripRoomPrefix(value: string, room: string) {
  const prefixes = [...new Set([room, humanRoomName(room), room.replace(/([a-z])([A-Z])/g, "$1 $2"), room.replace(/[-_]+/g, " ")])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  for (const prefix of prefixes) {
    const trimmed = stripPrefix(value, prefix);
    if (trimmed !== value) return trimmed;
  }
  return value;
}

function stripPrefix(value: string, prefix: string) {
  const leadingWhitespace = value.match(/^\s*/)?.[0].length ?? 0;
  const candidate = value.slice(leadingWhitespace);
  if (!candidate.toLowerCase().startsWith(prefix.toLowerCase())) return value;

  const next = candidate[prefix.length];
  const previous = candidate[prefix.length - 1];
  const hasBoundary = next === undefined || /[\s._:-]/.test(next) || (/[a-z0-9]/.test(previous) && /[A-Z]/.test(next));
  if (!hasBoundary) return value;

  const stripped = candidate.slice(prefix.length).replace(/^[\s._:-]+/, "").trim();
  return stripped || value;
}

type MatterResolvedBinding = NonNullable<NonNullable<Snapshot["providers"][number]["status"]>["resolved"]>[number];

function matterHealth(matter: Snapshot["providers"][number] | undefined, binding: MatterResolvedBinding | undefined) {
  if (matter?.status?.enabled === false) return { label: "disabled", tone: "muted" };
  if (!binding) return { label: "unresolved", tone: "warn" };
  if (binding.available === true) return { label: "online", tone: "ok" };
  if (binding.available === false) return { label: "offline", tone: "bad", offlineSince: binding.offlineSince };
  return { label: "unknown", tone: "muted" };
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
  const layeredStatus = statusFromLayer(target, layer?.surfaced, layered, raw, source);
  if (layeredStatus) return layeredStatus;
  if (target.capabilities?.buttons || target.capabilities?.events) return null;
  if (!display && !source) return null;
  const mapped = display?.values?.[String(raw)];
  if (typeof mapped === "string") return { label: mapped, tone: "unknown", since: source?.since ?? display?.since };
  if (mapped) return withStatusIcon(target, { label: mapped.label, tone: mapped.tone ?? "unknown" }, source);
  if (raw === undefined) return null;
  if (source?.property === "presence") return withStatusIcon(target, raw ? { label: "active", tone: "active" } : { label: "clear", tone: "idle" }, source);
  if (source?.property === "open") return withStatusIcon(target, raw ? { label: "open", tone: "open" } : { label: "closed", tone: "closed" }, source);
  if (typeof raw === "boolean") return withStatusIcon(target, raw ? { label: "on", tone: "on" } : { label: "off", tone: "off" }, source);
  if (typeof raw === "number" && target.capabilities?.position) {
    if (raw <= 5) return withStatusIcon(target, { label: "open", tone: "open", since: source?.since ?? display?.since });
    if (raw >= 95) return withStatusIcon(target, { label: "closed", tone: "closed", since: source?.since ?? display?.since });
    return { label: `${Math.round(raw)}%`, tone: "active", since: source?.since ?? display?.since };
  }
  return { label: formatValue(raw), tone: "unknown", since: source?.since ?? display?.since };
}

function withStatusIcon(
  target: Snapshot["targets"][number],
  status: DeviceStatus,
  source?: Snapshot["sources"][number],
) {
  const statusWithSince = status.since === undefined && source?.since !== undefined ? { ...status, since: source.since } : status;
  const isDoor = source?.property === "open" || String(target.capabilities?.product ?? "").toLowerCase().includes("door");
  const isLight = Boolean(target.capabilities?.power);
  const isPresence = source?.property === "presence" || String(target.capabilities?.product ?? "").toLowerCase().includes("presence");
  const isCover = Boolean(target.capabilities?.position || target.capabilities?.commands);
  if (isDoor && status.label === "open") return { ...statusWithSince, icon: <DoorOpen size={22} strokeWidth={2.2} aria-hidden="true" /> };
  if (isDoor && status.label === "closed") return { ...statusWithSince, icon: <DoorClosed size={22} strokeWidth={2.2} aria-hidden="true" /> };
  if (isCover && status.label === "open") return { ...statusWithSince, icon: <BlindStatusIcon state="open" /> };
  if (isCover && status.label === "closed") return { ...statusWithSince, icon: <BlindStatusIcon state="closed" /> };
  if (isCover && status.label === "opening") return { ...statusWithSince, icon: <BlindStatusIcon state="opening" /> };
  if (isCover && status.label === "closing") return { ...statusWithSince, icon: <BlindStatusIcon state="closing" /> };
  if (isCover && status.label === "stopped") return { ...statusWithSince, icon: <BlindStatusIcon state="stopped" /> };
  if (isLight && status.label === "on") return { ...statusWithSince, icon: <LightStatusIcon on /> };
  if (isLight && status.label === "off") return { ...statusWithSince, icon: <LightStatusIcon /> };
  if (isPresence && status.label === "active") return { ...statusWithSince, icon: <PresenceStatusIcon active /> };
  if (isPresence && status.label === "clear") return { ...statusWithSince, icon: <PresenceStatusIcon /> };
  return statusWithSince;
}

function LightStatusIcon({ on = false }: { on?: boolean }) {
  return (
    <span className={["light-status-icon", on ? "light-status-icon-on" : ""].filter(Boolean).join(" ")}>
      <Lightbulb size={22} strokeWidth={2.2} aria-hidden="true" />
      {on ? (
        <>
          <span className="light-ray light-ray-left" />
          <span className="light-ray light-ray-top" />
          <span className="light-ray light-ray-right" />
          <span className="light-ray light-ray-lower-left" />
          <span className="light-ray light-ray-lower-right" />
        </>
      ) : null}
    </span>
  );
}

function BlindStatusIcon({ state }: { state: "open" | "closed" | "opening" | "closing" | "stopped" }) {
  const covered = state === "closed" || state === "closing";
  return (
    <svg className="blind-status-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="1.8" />
      {covered ? (
        <>
          <path d="M4 8h16" />
          <path d="M4 12h16" />
          <path d="M4 16h16" />
        </>
      ) : null}
    </svg>
  );
}

function PresenceStatusIcon({ active = false }: { active?: boolean }) {
  if (active) return <UserRoundCheck size={22} strokeWidth={2.2} aria-hidden="true" />;
  return (
    <UserRound className="presence-status-icon-clear" size={22} strokeWidth={2.2} aria-hidden="true" />
  );
}

function statusFromLayer(
  target: Snapshot["targets"][number],
  surfaced: Snapshot["layers"][number]["surfaced"] | undefined,
  state: Record<string, unknown> | undefined,
  observed: unknown,
  source?: Snapshot["sources"][number],
) {
  if (!state) return undefined;
  if (target.capabilities?.position || target.capabilities?.commands) {
    if (state.motion === "stop") return withStatusIcon(target, { label: "stopped", tone: "idle", since: surfaced?.since });
    if (state.position === "open") {
      if (typeof observed === "number" && observed <= 5) return undefined;
      return withStatusIcon(target, { label: "opening", tone: "opening", since: surfaced?.since });
    }
    if (state.position === "closed") {
      if (typeof observed === "number" && observed >= 95) return undefined;
      return withStatusIcon(target, { label: "closing", tone: "closing", since: surfaced?.since });
    }
  }
  if ("power" in state) {
    return state.power === "off" || state.power === false
      ? withStatusIcon(target, { label: "off", tone: "off", since: source?.since ?? surfaced?.since }, source)
      : withStatusIcon(target, { label: "on", tone: "on", since: source?.since ?? surfaced?.since }, source);
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

function deviceRssi(
  target: Snapshot["targets"][number],
  sourceById: Map<string, Snapshot["sources"][number]>,
  binding?: MatterResolvedBinding,
) {
  const display = target.display?.rssi;
  const value = display ? sourceById.get(display.source)?.value ?? display.value : binding?.rssi;
  if (typeof value !== "number") return { label: "—", tone: "unknown" };
  const rounded = Math.round(value);
  const unit = display?.unit ?? "dBm";
  const tone = rounded < -85 ? "bad" : rounded <= -70 ? "warn" : "ok";
  return { label: `${rounded}${unit}`, tone };
}

function deviceRssiClass(tone: string) {
  const classes: Record<string, string> = {
    ok: "device-rssi device-rssi-ok",
    warn: "device-rssi device-rssi-warn",
    bad: "device-rssi device-rssi-bad",
    unknown: "device-rssi device-rssi-unknown",
  };
  return classes[tone] ?? classes.unknown;
}

function deviceMetrics(target: Snapshot["targets"][number], sourceById: Map<string, Snapshot["sources"][number]>) {
  return (target.display?.metrics ?? []).flatMap((metric) => {
    const value = sourceById.get(metric.source)?.value ?? metric.value;
    if (typeof value !== "number" && typeof value !== "string") return [];
    const formatted = typeof value === "number" ? `${Math.round(value)}${metric.unit ?? ""}` : `${value}${metric.unit ?? ""}`;
    return [{ label: `${metric.label}: ${formatted}`, tone: "ok" }];
  });
}

function deviceLastUpdated(target: Snapshot["targets"][number], sourceById: Map<string, Snapshot["sources"][number]>) {
  const displaySources = [
    target.display?.status?.source,
    target.display?.battery?.source,
    target.display?.rssi?.source,
    ...(target.display?.metrics ?? []).map((metric) => metric.source),
  ].filter((source): source is string => Boolean(source));
  const candidateTimes = [...sourceById.values()]
    .filter((source) => source.key === target.key || displaySources.includes(source.source))
    .map((source) => source.updatedAt)
    .filter((value): value is number => typeof value === "number");
  return candidateTimes.length ? Math.max(...candidateTimes) : undefined;
}

function DeviceStatusPill({ status, now }: { status: DeviceStatus; now: number }) {
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
  const duration = status.since ? formatForDuration(now - status.since) : undefined;
  const title = duration ? `${status.label} ${duration}` : status.label;
  return (
    <span className={`device-status ${classes[status.tone ?? "unknown"] ?? classes.unknown}`} title={title} aria-label={title}>
      <span className="device-status-main">{status.icon ?? status.label}</span>
      {duration ? <span className="device-status-duration">{duration}</span> : null}
    </span>
  );
}

function deviceFilterOptions(snapshot: Snapshot | null) {
  if (!snapshot) return [];
  return visibleDeviceTargets(snapshot.targets)
    .map((target) => ({
      value: target.target,
      label: target.key,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function automationFilterOptions(snapshot: Snapshot | null) {
  if (!snapshot) return [];
  return snapshot.rules
    .map((rule) => ({
      value: rule.name,
      label: rule.name,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
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
  const matterLog = (snapshot.matterLog ?? []).filter((entry) => inRoom(entry.subject) || (entry.key ? inRoom(entry.key) : false) || (entry.reason ? inRoom(entry.reason) : false));
  return {
    ...snapshot,
    sources,
    signals,
    targets,
    rules,
    layers,
    matterLog,
    events,
    eventActions,
  };
}

function filterSnapshotByLogFilters(snapshot: Snapshot | null, deviceFilter: string, automationFilter: string): Snapshot | null {
  if (!snapshot || (deviceFilter === "all" && automationFilter === "all")) return snapshot;
  const target = deviceFilter === "all" ? undefined : snapshot.targets.find((item) => item.target === deviceFilter);
  const deviceKey = target?.key ?? deviceFilter;
  const matchesDevice = (id: string) =>
    deviceFilter === "all" ||
    id === deviceFilter ||
    id === deviceKey ||
    id.startsWith(`${deviceFilter}.`) ||
    id.startsWith(`${deviceKey}.`);
  const rule = automationFilter === "all" ? undefined : snapshot.rules.find((item) => item.name === automationFilter);
  const deps = new Set(rule?.deps ?? []);
  const outputs = new Set(rule?.outputs ?? []);
  const matchesAutomation = (entry: NonNullable<Snapshot["matterLog"]>[number]) => {
    if (automationFilter === "all") return true;
    return (
      entry.reason === automationFilter ||
      deps.has(entry.subject) ||
      outputs.has(entry.subject) ||
      (entry.key ? deps.has(entry.key) || outputs.has(entry.key) : false)
    );
  };
  const matterLog = (snapshot.matterLog ?? []).filter((entry) => {
    const deviceMatches = deviceFilter === "all" || matchesDevice(entry.subject) || (entry.key ? matchesDevice(entry.key) : false);
    return deviceMatches && matchesAutomation(entry);
  });
  return { ...snapshot, matterLog };
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

function StatusPill({ status, now = Date.now() }: { status?: Snapshot["providers"][number]["status"]; now?: number }) {
  const health = matterProviderHealth(status, now);
  const counts = matterAvailabilityCounts(status);
  const label = health.label === "live" && counts ? `${counts.available}/${counts.total}` : health.label;
  return (
    <span
      className={`rounded-gaia border border-gaia-ink px-2 py-0.5 text-[0.68rem] font-black uppercase ${health.color}`}
      title={health.title}
    >
      {label}
    </span>
  );
}

function matterProviderHealth(status: Snapshot["providers"][number]["status"] | undefined, now: number) {
  if (status?.enabled === false) {
    return { label: "Disabled", color: "bg-gaia-yellow", title: "Matter provider is disabled" };
  }
  if (!status?.connected) {
    return { label: "Offline", color: "bg-gaia-red text-white", title: "Matter websocket is disconnected" };
  }
  if (status.lastMessageAt && now - status.lastMessageAt > 180_000) {
    return {
      label: "Stale",
      color: "bg-gaia-orange text-white",
      title: `No Matter websocket messages for ${formatDuration(now - status.lastMessageAt)}`,
    };
  }
  return { label: "live", color: "bg-gaia-green", title: status.lastMessageAt ? `Last message ${formatDuration(now - status.lastMessageAt)} ago` : "Matter websocket is connected" };
}

function matterAvailabilityCounts(status?: Snapshot["providers"][number]["status"]) {
  if (!status || status.enabled === false) return null;
  const total = status.nodeCount ?? status.resolved?.length ?? 0;
  if (!total) return null;
  const availableNodeIds = new Set((status.resolved ?? []).filter((binding) => binding.available === true).map((binding) => binding.nodeId));
  return { available: availableNodeIds.size, total };
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function formatForDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
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

function formatTimestamp(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).format(value);
}

function matterLogDetail(entry: NonNullable<Snapshot["matterLog"]>[number]) {
  if (entry.kind === "command") {
    const parts = [entry.reason, entry.state ? formatValue(entry.state) : undefined, entry.error].filter(Boolean);
    return parts.join(" · ") || "command";
  }
  const source = entry.property ? `${entry.key ?? entry.subject}.${entry.property}` : entry.key ?? entry.subject;
  return `${source} = ${formatValue(entry.value)}`;
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
