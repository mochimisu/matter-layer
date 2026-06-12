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
import { epaperDisplays, type EpaperDisplayDefinition, type EpaperStatDefinition } from "../../src/displays";
import { buildFlowLanes, layoutFlowLanes, type FlowNodeModel } from "./flowGraph";
import { applySnapshotDelta, type LiveMessage, type Snapshot } from "./snapshotDeltas";
import "./style.css";

type AppTab = "devices" | "details" | "graph" | "log" | "epaper";
type DeviceOpResult = { label: string; tone: "ok" | "bad"; title?: string };
type DeviceStatus = { label: string; tone?: string; icon?: ReactNode; since?: number };
type EpaperExpandedDep = { source: string; active: boolean };
type EpaperRenderEvent = {
  type: "epaper.snapshot" | "epaper.update";
  display: string;
  generatedAt: number;
  url: string;
};
const epaperStatValueCache = new Map<string, { value: string; updatedAt: number }>();
const epaperPreviewRenderCache = new Map<string, { fingerprint: string; generatedAt: number }>();
const epaperInactiveLine = "#999999";

function tabFromLocation(): AppTab {
  const tab = new URLSearchParams(location.search).get("tab");
  return tab === "graph" || tab === "details" || tab === "log" || tab === "epaper" ? tab : "devices";
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

function deviceFromLocation() {
  const detailPrefix = "/details/";
  if (location.pathname.startsWith(detailPrefix)) {
    return decodeURIComponent(location.pathname.slice(detailPrefix.length));
  }
  return new URLSearchParams(location.search).get("deviceDetail");
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deviceOpResults, setDeviceOpResults] = useState<Record<string, DeviceOpResult>>({});
  const [tab, setTab] = useState<AppTab>(() => tabFromLocation());
  const [roomFilter, setRoomFilter] = useState(() => roomFromLocation());
  const [logDeviceFilter, setLogDeviceFilter] = useState(() => logDeviceFromLocation());
  const [logAutomationFilter, setLogAutomationFilter] = useState(() => logAutomationFromLocation());
  const [selectedDevice, setSelectedDevice] = useState<string | null>(() => deviceFromLocation());
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

  useEffect(() => {
    function syncLocation() {
      setTab(tabFromLocation());
      setRoomFilter(roomFromLocation());
      setLogDeviceFilter(logDeviceFromLocation());
      setLogAutomationFilter(logAutomationFromLocation());
      setSelectedDevice(deviceFromLocation());
    }
    window.addEventListener("popstate", syncLocation);
    return () => window.removeEventListener("popstate", syncLocation);
  }, []);

  function selectTab(next: AppTab) {
    setTab(next);
    setSelectedDevice(null);
    const url = new URL(location.href);
    url.pathname = "/";
    url.searchParams.delete("deviceDetail");
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

  function selectDeviceDetail(next: string | null) {
    setSelectedDevice(next);
    const url = new URL(location.href);
    url.searchParams.delete("deviceDetail");
    if (next) {
      url.pathname = `/details/${encodeURIComponent(next)}`;
      url.searchParams.delete("tab");
    } else {
      url.pathname = "/";
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

  async function setMatterRemoteKeepalive(enabled: boolean) {
    await mutate("matter-remote-keepalive", "/api/matter/remote-keepalive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
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
    { id: "epaper" as const, label: "E-Paper", title: "E-Paper Preview" },
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
                <label className="header-keepalive-toggle" title="Toggle periodic Matter ping_node keepalive probes for remotes">
                  <input
                    type="checkbox"
                    checked={matter?.status?.remoteKeepaliveEnabled !== false}
                    disabled={busy === "matter-remote-keepalive" || matter?.status?.enabled === false}
                    onChange={(event) => void setMatterRemoteKeepalive(event.target.checked)}
                  />
                  <span>Keepalive</span>
                </label>
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
                            <span className="truncate text-gaia-muted" title={layerOutputLabel(item.output)}>
                              {layerOutputLabel(item.output)}
                            </span>
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
              snapshot={selectedDevice ? snapshot : visibleSnapshot}
              matter={matter}
              now={now}
              busy={busy}
              selectedDevice={selectedDevice}
              onSetOverride={setOverride}
              onSetSource={setSource}
              onClearOverride={clearOverride}
              onClearSource={clearSource}
              onDispatchEvent={dispatchDeviceEvent}
              onPingDevice={pingDevice}
              onProbeDevice={probeDevice}
              onSelectDevice={selectDeviceDetail}
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
          ) : tab === "epaper" ? (
            <EpaperPreview snapshot={snapshot} now={now} />
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
  selectedDevice,
  onSelectDevice,
  deviceOpResults,
}: {
  snapshot: Snapshot | null;
  matter: Snapshot["providers"][number] | undefined;
  now: number;
  busy: string | null;
  selectedDevice: string | null;
  onSetOverride: (target: string, state: Record<string, unknown>, ttl?: string) => Promise<void>;
  onSetSource: (source: string, value: unknown, ttl?: string) => Promise<void>;
  onClearOverride: (target: string) => Promise<void>;
  onClearSource: (source: string) => Promise<void>;
  onDispatchEvent: (event: string) => Promise<void>;
  onPingDevice: (target: string) => Promise<void>;
  onProbeDevice: (target: string) => Promise<void>;
  onSelectDevice: (target: string | null) => void;
  deviceOpResults: Record<string, DeviceOpResult>;
}) {
  const layersByTarget = new Map((snapshot?.layers ?? []).map((layer) => [layer.target, layer]));
  const sourceById = new Map((snapshot?.sources ?? []).map((source) => [source.source, source]));
  const resolvedByKey = new Map((matter?.status?.resolved ?? []).map((binding) => [binding.key, binding]));
  const rooms = groupTargetsByRoom(snapshot?.targets ?? []);
  const selectedTarget = (snapshot?.targets ?? []).find((target) => target.target === selectedDevice) ?? null;
  let deviceRowIndex = 0;
  if (selectedTarget) {
    return (
      <DeviceDetail
        target={selectedTarget}
        layer={layersByTarget.get(selectedTarget.target)}
        sourceById={sourceById}
        onClose={() => onSelectDevice(null)}
      />
    );
  }
  return (
    <section className="gaia-panel device-room">
      <div className="device-table">
        <div className="device-table-header">
          <span>Status</span>
          <span>Device</span>
          <span>Layer</span>
          <span>Reason</span>
          <span>Metrics</span>
          <span>Updated</span>
          <span>Probe</span>
          <span>RSSI</span>
          <span>Actions</span>
          <span>Ops</span>
        </div>
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
              const health = deviceProviderHealth(target, matter, binding);
              const battery = deviceBattery(target, sourceById);
              const rssi = deviceRssi(target, sourceById, binding);
              const metrics = deviceMetrics(target, sourceById);
              const updatedAt = deviceLastUpdated(target, sourceById);
              const lastProbeAt = binding?.lastProbeAt;
              const vendor = String(target.capabilities?.vendor ?? "");
              const product = String(target.capabilities?.product ?? "");
              const label = deviceResolvedLabel(target, binding?.label);
              const displayLabel = deviceDisplayLabel(label, target, room);
              const deviceInfo = [label, target.key, [vendor, product].filter(Boolean).join(" ")].filter(Boolean);
              const reason = layer?.surfaced ? layerOutputLabel(layer.surfaced.output) : "";
              const actions = deviceActions(target, sourceById, onSetOverride, onSetSource, onClearOverride, onClearSource, onDispatchEvent);
              const rowClass = deviceRowIndex++ % 2 === 0 ? "device-table-row device-table-row-striped" : "device-table-row";
              return (
                <article key={target.target} className={rowClass}>
                  <span>{status ? <DeviceStatusPill status={status} now={now} /> : null}</span>
                  <span className="device-name-with-health">
                    <button
                      className="device-detail-link"
                      onClick={() => onSelectDevice(target.target)}
                      aria-current={selectedDevice === target.target ? "true" : undefined}
                    >
                      <DeviceName label={displayLabel} details={deviceInfo} offline={health.tone === "bad"} offlineSince={health.offlineSince} />
                    </button>
                  </span>
                  <span><LayerBadge layer={layer?.surfaced?.layer} /></span>
                  <span className="min-w-0 truncate text-xs text-gaia-muted" title={reason || undefined}>{reason}</span>
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

function DeviceDetail({
  target,
  layer,
  sourceById,
  onClose,
}: {
  target: Snapshot["targets"][number];
  layer?: Snapshot["layers"][number];
  sourceById: Map<string, Snapshot["sources"][number]>;
  onClose: () => void;
}) {
  const status = deviceStatus(target, sourceById, layer);
  return (
    <section className="gaia-panel device-detail-panel">
      <div className="gaia-panel-head border-l-4 border-l-gaia-cyan">
        <div className="min-w-0">
          <h2 className="gaia-title truncate">{target.key}</h2>
          <div className="truncate text-xs font-bold text-gaia-muted">{target.target}</div>
        </div>
        <button className="gaia-button" onClick={onClose}>Back</button>
      </div>
      <div className="device-detail-body">
        <div className="device-detail-summary">
          <div>{status ? <DeviceStatusPill status={status} now={Date.now()} /> : <span className="gaia-chip">No status</span>}</div>
          <LayerBadge layer={layer?.surfaced?.layer} />
          <code className="device-detail-code">{formatValue(layer?.surfaced?.output.state ?? null)}</code>
        </div>
        <div className="device-stack">
          {(layer?.layers ?? []).length ? layer!.layers.map((bucket) => (
            <div key={bucket.layer} className="device-stack-layer">
              <div className="device-stack-layer-head">
                <LayerBadge layer={bucket.layer} />
                <span className="truncate text-xs font-bold text-gaia-muted" title={layerOutputLabel(bucket.output)}>
                  {layerOutputLabel(bucket.output)}
                </span>
              </div>
              <code className="device-detail-code">{formatValue(bucket.output.state)}</code>
              <div className="device-stack-items">
                {(bucket.items ?? [{ key: bucket.layer, output: bucket.output, since: bucket.since }]).map((item) => (
                  <div key={item.key} className="device-stack-item">
                    <span className="truncate font-black">{item.key}</span>
                    <span className="truncate text-gaia-muted" title={layerOutputLabel(item.output)}>
                      {item.output.reason ?? item.output.writer ?? "opinion"}
                    </span>
                    <code>{formatValue(item.output.state)}</code>
                  </div>
                ))}
              </div>
            </div>
          )) : (
            <div className="gaia-row text-sm font-bold text-gaia-muted">No active layer opinions.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function roomAvailability(targets: Snapshot["targets"], resolvedByKey: Map<string, MatterResolvedBinding>) {
  let available = 0;
  for (const target of targets) {
    const binding = resolvedByKey.get(target.key) ?? resolvedByKey.get(target.target);
    if (target.provider !== "matter" || binding?.available === true) available += 1;
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

function EpaperPreview({ snapshot, now }: { snapshot: Snapshot | null; now: number }) {
  return (
    <section className="gaia-panel epaper-preview-panel">
      <div className="gaia-panel-head border-l-4 border-l-gaia-cyan">
        <h2 className="gaia-title">E-Paper Preview</h2>
        <span className="gaia-chip">800x480 grayscale</span>
      </div>
      <div className="epaper-preview-stage">
        {epaperDisplays.map((display) => (
          <div key={display.id} className="epaper-preview-item">
            <div className="epaper-preview-label">
              <span>{display.title ?? humanRoomName(display.room)}</span>
              <code>/api/epaper/{display.id}.png</code>
            </div>
            <RoomEpaperImage snapshot={snapshot} now={now} display={display} />
          </div>
        ))}
      </div>
    </section>
  );
}

function RoomEpaperImage({ snapshot, now, display }: { snapshot: Snapshot | null; now: number; display: EpaperDisplayDefinition }) {
  const fallbackGeneratedAt = floorToMinute(now);
  const fallbackVersion = snapshot ? epaperImageVersion(snapshot, display.room, fallbackGeneratedAt) : fallbackGeneratedAt;
  const fallbackUrl = epaperPreviewUrl(display.id, fallbackVersion);
  const [renderState, setRenderState] = useState<{ url: string; generatedAt?: number }>(() => ({
    url: fallbackUrl,
  }));

  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    const connect = () => {
      if (!active) return;
      const query = new URLSearchParams({ palette: "grayscale" });
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/epaper-events/${encodeURIComponent(display.id)}?${query.toString()}`);
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as EpaperRenderEvent;
          if (!active || message.display !== display.id) return;
          setRenderState({
            url: epaperPreviewUrlFromRenderEvent(message),
            generatedAt: message.generatedAt,
          });
        } catch {}
      };
      ws.onclose = () => {
        ws = null;
        if (!active) return;
        reconnectTimer = window.setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      active = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [display.id]);

  return (
    <>
      <img className="epaper-image" src={renderState.url} width="800" height="480" alt={`${display.title ?? humanRoomName(display.room)} e-paper rendered preview`} />
      <div className="epaper-generated-at">
        {renderState.generatedAt ? `Generated at ${formatEpaperTime(renderState.generatedAt)}` : "Waiting for renderer timestamp"}
      </div>
    </>
  );

  const renderNow = floorToMinute(now);
  const room = display.room;
  const roomSnapshot = filterSnapshot(snapshot, room);
  const sourceById = new Map((roomSnapshot?.sources ?? []).map((source) => [source.source, source]));
  const layerByTarget = new Map((roomSnapshot?.layers ?? []).map((layer) => [layer.target, layer]));
  const targetById = new Map((roomSnapshot?.targets ?? []).map((target) => [target.target, target]));
  const matter = snapshot?.providers.find((provider) => provider.name === "matter");
  const bindingByKey = new Map((matter?.status?.resolved ?? []).map((binding) => [binding.key, binding]));
  const devices = visibleDeviceTargets(roomSnapshot?.targets ?? [])
    .map((target) => {
      const layer = layerByTarget.get(target.target);
      const status = deviceStatus(target, sourceById, layer);
      const binding = bindingByKey.get(target.key) ?? bindingByKey.get(target.target);
      const health = deviceProviderHealth(target, matter, binding);
      return {
        target,
        label: truncateMiddle(deviceDisplayLabel(deviceResolvedLabel(target, binding?.label), target, room), 22),
        status: status?.label ?? health.label,
        tone: status?.tone ?? health.tone,
        online: health.tone !== "bad",
        icon: epaperDeviceIconKind(target, status?.label),
        layer: layer?.surfaced?.layer,
        detail: layer?.surfaced?.layer ?? "",
      };
    });
  const compactDevices = devices.length > 7;
  const onlineDevices = compactDevices
    ? devices.filter((device) => device.online).slice(0, 10)
    : devices.filter((device) => device.online).slice(0, devices.some((device) => !device.online) ? 5 : 7);
  const offlineDevices = compactDevices
    ? devices.filter((device) => !device.online).slice(0, 3)
    : devices.filter((device) => !device.online).slice(0, 2);
  const deviceRowStep = compactDevices ? 25 : 47;
  const offlineHeaderY = 100 + onlineDevices.length * deviceRowStep + (compactDevices ? 15 : 18);
  const rules = roomSnapshot?.rules ?? [];
  const eventActions = roomSnapshot?.eventActions ?? [];
  const signalById = new Map((snapshot?.signals ?? []).map((signal) => [signal.id, signal]));
  const transitiveDepActiveById = epaperTransitiveDepActivity(snapshot, renderNow);
  const activeFlowSources = new Set<string>();
  const causalFlowSources = new Set<string>();
  const activeFlowSinks = new Set<string>();
  const automations = [
    ...rules.map((rule) => {
      const deps = uniqueEpaperDepStates(rule.deps.flatMap((dep) => expandEpaperSourceDeps(dep, signalById, sourceById, transitiveDepActiveById)), 8);
      const causes = uniqueEpaperCauseSources(rule.causes?.flatMap((dep) => expandEpaperCauseDeps(dep, signalById, sourceById)) ?? [], 8);
      const outputWrites = epaperRuleOutputWrites(rule, roomSnapshot?.layers ?? []);
      const outputs = epaperVisibleFlowOutputs(outputWrites.map((write) => write.target), targetById);
      for (const dep of deps) {
        if (dep.active) activeFlowSources.add(epaperFlowLabel(dep.source, room, 48));
      }
      for (const cause of causes) {
        causalFlowSources.add(epaperFlowLabel(cause, room, 48));
      }
      for (const output of outputs) {
        if (epaperOutputActive(layerByTarget.get(output)?.surfaced?.output.state)) activeFlowSinks.add(epaperFlowLabel(output, room, 48));
      }
      return {
        name: rule.name,
        enabled: rule.enabled,
        deps: deps.map((dep) => epaperFlowLabel(dep.source, room, 48)),
        outputs: outputs.map((output) => epaperFlowLabel(output, room, 48)),
        activeOutputs: outputWrites
          .filter((write) => write.hasOutput && outputs.includes(write.target))
          .map((write) => epaperFlowLabel(write.target, room, 48)),
        lastRunAt: rule.lastRunAt,
      };
    }),
    ...eventActions.map((action) => {
      if (action.lastRunAt && renderNow - action.lastRunAt <= 5 * 60 * 1000) activeFlowSources.add(epaperFlowLabel(action.event, room, 48));
      const outputs = epaperVisibleFlowOutputs(action.outputs, targetById);
      for (const output of outputs) {
        if (epaperOutputActive(layerByTarget.get(output)?.surfaced?.output.state)) activeFlowSinks.add(epaperFlowLabel(output, room, 48));
      }
      return {
        name: action.name,
        enabled: true,
        deps: [epaperFlowLabel(action.event, room, 48)],
        outputs: outputs.map((output) => epaperFlowLabel(output, room, 48)),
        activeOutputs: outputs
          .filter((output) => eventActionHasEpaperOpinion(layerByTarget.get(output)))
          .map((output) => epaperFlowLabel(output, room, 48)),
        lastRunAt: action.lastRunAt,
      };
    }),
  ].filter((automation) => automation.outputs.length > 0).slice(0, 6);
  const statCards = epaperStats(snapshot, display.stats ?? [], renderNow);
  const flowY = statCards.length ? 142 : 100;
  const epaperFlow = buildEpaperFlow(automations, activeFlowSources, new Set([...activeFlowSources, ...causalFlowSources]), activeFlowSinks, flowY);
  const generatedAt = epaperPreviewGeneratedAt(display.id, epaperPreviewFingerprint(snapshot, display, renderNow), renderNow);

  return (
    <>
    <svg className="epaper-image" viewBox="0 0 800 480" role="img" aria-label="Office e-paper status preview">
      <defs>
        <pattern id="epaper-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#111" strokeOpacity="0.08" strokeWidth="1" />
        </pattern>
        <pattern id="epaper-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="#111" strokeOpacity="0.22" strokeWidth="2" />
        </pattern>
      </defs>
      <rect width="800" height="480" fill="#fbfbf6" />
      <rect width="800" height="480" fill="url(#epaper-grid)" />
      <rect x="0" y="0" width="800" height="48" fill="#111" />
      <text x="24" y="31" fill="#fff" fontFamily="Inter, Arial, sans-serif" fontSize="24" fontWeight="900">{(display.title ?? humanRoomName(room)).toUpperCase()}</text>

      <text x="24" y="76" fill="#111" fontFamily="Inter, Arial, sans-serif" fontSize="14" fontWeight="900">DEVICES</text>
      <text x="408" y="76" fill="#111" fontFamily="Inter, Arial, sans-serif" fontSize="14" fontWeight="900">DRIVES</text>
      <line x1="24" y1="84" x2="386" y2="84" stroke="#111" strokeWidth="2" />
      <line x1="408" y1="84" x2="776" y2="84" stroke="#111" strokeWidth="2" />
      {statCards.length ? <EpaperStatCards stats={statCards} /> : null}

      {onlineDevices.map((device, index) => compactDevices ? (
        <EpaperCompactDeviceRow key={device.target.target} device={device} y={100 + index * deviceRowStep} />
      ) : (
        <EpaperDeviceRow key={device.target.target} device={device} y={100 + index * deviceRowStep} />
      ))}
      {offlineDevices.length ? (
        <g>
          <text x="24" y={offlineHeaderY} fill="#111" fontFamily="Inter, Arial, sans-serif" fontSize="12" fontWeight="900">OFFLINE</text>
          <line x1="82" y1={offlineHeaderY - 4} x2="386" y2={offlineHeaderY - 4} stroke="#111" strokeWidth="1.5" />
          {offlineDevices.map((device, index) => compactDevices ? (
            <EpaperCompactDeviceRow key={device.target.target} device={device} y={offlineHeaderY + 8 + index * deviceRowStep} />
          ) : (
            <EpaperDeviceRow key={device.target.target} device={device} y={offlineHeaderY + 12 + index * deviceRowStep} />
          ))}
        </g>
      ) : null}
      {devices.length === 0 ? (
        <text x="24" y="128" fill="#111" fontFamily="Inter, Arial, sans-serif" fontSize="15" fontWeight="700">No devices resolved.</text>
      ) : null}

      {epaperFlow.edges.length ? (
        <EpaperFlowGraph flow={epaperFlow} />
      ) : (
        <text x="408" y={statCards.length ? 160 : 128} fill="#111" fontFamily="Inter, Arial, sans-serif" fontSize="15" fontWeight="700">No drives.</text>
      )}
    </svg>
    <div className="epaper-generated-at">Generated at {formatEpaperTime(generatedAt)}</div>
    </>
  );
}

function EpaperCompactDeviceRow({
  device,
  y,
}: {
  device: {
    label: string;
    status: string;
    tone?: string;
    online: boolean;
    icon: EpaperDeviceIconKind;
    layer?: string;
    detail: string;
  };
  y: number;
}) {
  const active = ["on", "open", "active", "opening", "closing"].includes(String(device.tone));
  const layer = device.layer ?? "";
  return (
    <g>
      <rect x="24" y={y} width="362" height="20" fill={active ? "#111" : "#fbfbf6"} stroke="#111" strokeWidth="1.5" />
      <text x="36" y={y + 14} fill={active ? "#fff" : "#111"} fontFamily="Inter, Arial, sans-serif" fontSize="11" fontWeight="900">
        {truncateText(device.label, 20)}
      </text>
      <text x="184" y={y + 14} fill={active ? "#fff" : "#111"} fontFamily="Inter, Arial, sans-serif" fontSize="9" fontWeight="900">
        {layer ? `[${truncateText(layer, 18)}]` : ""}
      </text>
      <text x="374" y={y + 14} fill={active ? "#fff" : "#111"} fontFamily="Inter, Arial, sans-serif" fontSize="10" fontWeight="900" textAnchor="end">
        {truncateText(device.status.toUpperCase(), 10)}
      </text>
    </g>
  );
}

function EpaperDeviceRow({
  device,
  y,
}: {
  device: {
    label: string;
    status: string;
    tone?: string;
    online: boolean;
    icon: EpaperDeviceIconKind;
    layer?: string;
    detail: string;
  };
  y: number;
}) {
  const active = ["on", "open", "active", "opening", "closing"].includes(String(device.tone));
  return (
    <g>
      <rect x="24" y={y} width="362" height="38" fill={active ? "#111" : "#fbfbf6"} stroke="#111" strokeWidth="2" />
      <rect x="24" y={y} width="9" height="38" fill={device.layer ? "#111" : "url(#epaper-hatch)"} />
      <EpaperDeviceIcon kind={device.icon} x={43} y={y + 8} active={active} />
      <text x="70" y={y + 16} fill={active ? "#fff" : "#111"} fontFamily="Inter, Arial, sans-serif" fontSize="14" fontWeight="900">
        {device.label}
      </text>
      <text x="70" y={y + 31} fill={active ? "#fff" : "#111"} fontFamily="Inter, Arial, sans-serif" fontSize="10" fontWeight="900">
        {truncateText(device.layer || "no active layer", 33)}
      </text>
      <text x="374" y={y + 17} fill={active ? "#fff" : "#111"} fontFamily="Inter, Arial, sans-serif" fontSize="12" fontWeight="900" textAnchor="end">
        {truncateText(device.status.toUpperCase(), 11)}
      </text>
    </g>
  );
}

type EpaperDeviceIconKind = "light" | "blind" | "presence" | "door" | "generic";

function epaperDeviceIconKind(target: Snapshot["targets"][number], status?: string): EpaperDeviceIconKind {
  const product = String(target.capabilities?.product ?? "").toLowerCase();
  if (target.capabilities?.position || target.capabilities?.commands) return "blind";
  if (target.capabilities?.power) return "light";
  if (product.includes("presence")) return "presence";
  if (status === "open" || status === "closed" || product.includes("door")) return "door";
  return "generic";
}

function EpaperDeviceIcon({ kind, x, y, active }: { kind: EpaperDeviceIconKind; x: number; y: number; active: boolean }) {
  const stroke = active ? "#fff" : "#111";
  const fill = active ? "#111" : "#fbfbf6";
  if (kind === "light") {
    return (
      <g stroke={stroke} fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={`M ${x + 7} ${y + 4} a 6 6 0 0 1 4 10 c -1 1 -1.5 2 -1.5 3 h -5 c 0 -1 -0.5 -2 -1.5 -3 a 6 6 0 0 1 4 -10`} />
        <path d={`M ${x + 4.5} ${y + 19} h 5`} />
        <path d={`M ${x + 3} ${y + 2} l -2 -2 M ${x + 11} ${y + 2} l 2 -2 M ${x + 7} ${y} v -3`} />
      </g>
    );
  }
  if (kind === "blind") {
    return (
      <g stroke={stroke} fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x={x + 1} y={y + 2} width="16" height="16" rx="1.5" fill={fill} />
        <path d={`M ${x + 1} ${y + 7} h 16 M ${x + 1} ${y + 11} h 16 M ${x + 1} ${y + 15} h 16`} />
      </g>
    );
  }
  if (kind === "presence") {
    return (
      <g stroke={stroke} fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx={x + 9} cy={y + 6} r="4" />
        <path d={`M ${x + 2.5} ${y + 20} c 1.4 -5 11.6 -5 13 0`} />
        <path d={`M ${x + 15} ${y + 3} l 3 3 l 5 -6`} />
      </g>
    );
  }
  if (kind === "door") {
    return (
      <g stroke={stroke} fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={`M ${x + 4} ${y + 20} v -17 h 11 v 17`} />
        <path d={`M ${x + 11} ${y + 11} h 1`} />
      </g>
    );
  }
  return (
    <g stroke={stroke} fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x={x + 3} y={y + 3} width="14" height="14" rx="2" />
      <path d={`M ${x + 7} ${y + 10} h 6 M ${x + 10} ${y + 7} v 6`} />
    </g>
  );
}

type EpaperFlowNode = {
  id: string;
  label: string;
  title: string;
  detail: string;
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
};
type EpaperFlowEdge = { id: string; from: EpaperFlowNode; to: EpaperFlowNode; laneX: number; sourceOffset: number; sinkOffset: number; enabled: boolean };
type EpaperFlow = { sources: EpaperFlowNode[]; sinks: EpaperFlowNode[]; edges: EpaperFlowEdge[] };

function EpaperFlowGraph({ flow }: { flow: EpaperFlow }) {
  const orderedEdges = [false, true].flatMap((enabled) => flow.edges.filter((edge) => edge.enabled === enabled));
  return (
    <g>
      {flow.edges.map((edge) => {
        const fromY = edge.from.y + edge.from.h / 2 + edge.sourceOffset;
        const toY = edge.to.y + edge.to.h / 2 + edge.sinkOffset;
        return (
          <g key={edge.id}>
            <path
              d={epaperCurvedPath(edge.from.x + edge.from.w, fromY, edge.laneX, edge.to.x, toY)}
              fill="none"
              stroke="#fbfbf6"
              strokeWidth="6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
      {orderedEdges.map((edge) => {
        const fromY = edge.from.y + edge.from.h / 2 + edge.sourceOffset;
        const toY = edge.to.y + edge.to.h / 2 + edge.sinkOffset;
        return (
          <path
            key={`${edge.id}:stroke`}
            d={epaperCurvedPath(edge.from.x + edge.from.w, fromY, edge.laneX, edge.to.x, toY)}
            fill="none"
            stroke={edge.enabled ? "#111" : epaperInactiveLine}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={edge.enabled ? undefined : "5 4"}
          />
        );
      })}
      {[...flow.sources, ...flow.sinks].map((node) => (
        <g key={node.id}>
          <rect x={node.x} y={node.y} width={node.w} height={node.h} fill={node.active ? "#111" : "#fbfbf6"} stroke="#111" strokeWidth="2" />
          <rect x={node.x} y={node.y} width="7" height={node.h} fill="#111" />
          <text x={node.x + node.w / 2 + 4} y={node.y + 16} fill={node.active ? "#fff" : "#111"} fontFamily="Inter, Arial, sans-serif" fontSize="10" fontWeight="900" textAnchor="middle">
            {node.title}
          </text>
        </g>
      ))}
    </g>
  );
}

function EpaperStatCards({ stats }: { stats: Array<{ label: string; value: string }> }) {
  return (
    <g>
      {stats.slice(0, 3).map((stat, index) => {
        const x = 408 + index * 123;
        return (
          <g key={stat.label}>
            <rect x={x} y="92" width="116" height="36" fill="#fbfbf6" stroke="#111" strokeWidth="2" />
            <text x={x + 8} y="106" fill="#111" fontFamily="Inter, Arial, sans-serif" fontSize="8" fontWeight="900">
              {stat.label.toUpperCase()}
            </text>
            <text x={x + 8} y="123" fill="#111" fontFamily="Inter, Arial, sans-serif" fontSize="19" fontWeight="900">
              {stat.value}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function buildEpaperFlow(
  automations: Array<{ enabled: boolean; deps: string[]; outputs: string[]; activeOutputs?: string[] }>,
  activeSources = new Set<string>(),
  causalSources = activeSources,
  activeSinks = new Set<string>(),
  yStart = 100,
): EpaperFlow {
  const sinkIds = uniqueLimited(automations.flatMap((automation) => automation.outputs), 6);
  const sourceIds = prioritizedEpaperSourceIds(automations, sinkIds, 8);
  const sourceGroups = groupEpaperSourceLabels(sourceIds, activeSources);
  const sourceNodes = sourceGroups.map((group, index) => ({
    id: `source:${group.key}`,
    label: group.key,
    title: group.title,
    detail: group.detail,
    x: 408,
    y: yStart + index * 31,
    w: 126,
    h: 23,
    active: group.active,
  }));
  const sinkNodes = sinkIds.map((label, index) => ({
    id: `sink:${label}`,
    label,
    ...splitEpaperFlowNodeLabel(label),
    x: 650,
    y: yStart + index * 35,
    w: 126,
    h: 25,
    active: activeSinks.has(label),
  }));
  const sourceByLabel = new Map(sourceGroups.flatMap((group, index) => group.labels.map((label) => [label, sourceNodes[index]] as const)));
  const sinkByLabel = new Map(sinkNodes.map((node) => [node.label, node]));
  const rawEdges = automations.flatMap((automation) =>
    automation.deps.flatMap((dep) =>
      automation.outputs.map((output) => ({
        sourceLabel: dep,
        sinkLabel: output,
        enabled: automation.enabled
          && causalSources.has(dep)
          && (automation.activeOutputs ? automation.activeOutputs.includes(output) : true),
      })),
    ),
  );
  const deduped = prioritizeEpaperEdges(uniqueEdges(rawEdges), sinkIds, 14);
  const resolvedEdges = uniqueResolvedEpaperEdges(deduped.flatMap((edge) => {
    const from = sourceByLabel.get(edge.sourceLabel);
    const to = sinkByLabel.get(edge.sinkLabel);
    if (!from || !to) return [];
    return [{ ...edge, from, to }];
  }));
  return {
    sources: sourceNodes,
    sinks: sinkNodes,
    edges: resolvedEdges.map((edge, index) => ({
        id: `${edge.sourceLabel}:${edge.sinkLabel}:${index}`,
        from: edge.from,
        to: edge.to,
        laneX: 552 + (index % 7) * 5,
        sourceOffset: portOffset(indexForResolvedEdgeNode(resolvedEdges, edge.from.id, "from", index), countResolvedEdgesForNode(resolvedEdges, edge.from.id, "from")),
        sinkOffset: portOffset(indexForResolvedEdgeNode(resolvedEdges, edge.to.id, "to", index), countResolvedEdgesForNode(resolvedEdges, edge.to.id, "to")),
        enabled: edge.enabled,
    })),
  };
}

function prioritizeEpaperEdges(edges: Array<{ sourceLabel: string; sinkLabel: string; enabled: boolean }>, sinkIds: string[], limit: number) {
  const prioritized: Array<{ sourceLabel: string; sinkLabel: string; enabled: boolean }> = [];
  const edgesBySink = sinkIds.map((sink) => edges.filter((edge) => edge.sinkLabel === sink));
  for (let index = 0; index < limit; index += 1) {
    for (const sinkEdges of edgesBySink) {
      const edge = sinkEdges[index];
      if (edge) prioritized.push(edge);
    }
  }
  return uniqueEdges([...prioritized, ...edges]).slice(0, limit);
}

function epaperSourceActive(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !["", "off", "closed", "clear", "idle", "false", "unknown", "unavailable"].includes(value.toLowerCase());
  return false;
}

function expandEpaperSourceDeps(
  dep: string,
  signalById: Map<string, Snapshot["signals"][number]>,
  sourceById: Map<string, Snapshot["sources"][number]>,
  transitiveDepActiveById = new Map<string, boolean>(),
  seen = new Set<string>(),
): EpaperExpandedDep[] {
  if (dep === "time.tick" || seen.has(dep)) return [];
  const signal = signalById.get(dep);
  if (!signal) {
    return sourceById.has(dep)
      ? [{ source: dep, active: epaperSourceActive(sourceById.get(dep)?.value) }]
      : [];
  }
  seen.add(dep);
  const gateStates = signal.deps
    .filter((signalDep) => !signalById.has(signalDep) && !sourceById.has(signalDep) && signalDep !== "time.tick")
    .map((signalDep) => transitiveDepActiveById.get(signalDep))
    .filter((active): active is boolean => typeof active === "boolean");
  const gateActive = gateStates.length ? gateStates.some(Boolean) : true;
  return signal.deps.flatMap((signalDep) =>
    expandEpaperSourceDeps(signalDep, signalById, sourceById, transitiveDepActiveById, new Set(seen))
      .map((expanded) => ({ ...expanded, active: expanded.active && gateActive })),
  );
}

function expandEpaperCauseDeps(
  dep: string,
  signalById: Map<string, Snapshot["signals"][number]>,
  sourceById: Map<string, Snapshot["sources"][number]>,
  seen = new Set<string>(),
): string[] {
  if (dep === "time.tick" || seen.has(dep)) return [];
  const signal = signalById.get(dep);
  if (!signal) return sourceById.has(dep) ? [dep] : [];
  seen.add(dep);
  return signal.deps.flatMap((signalDep) => expandEpaperCauseDeps(signalDep, signalById, sourceById, new Set(seen)));
}

function uniqueEpaperCauseSources(values: string[], limit: number) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function uniqueEpaperDepStates(values: EpaperExpandedDep[], limit: number): EpaperExpandedDep[] {
  const activeBySource = new Map<string, boolean>();
  for (const value of values) {
    activeBySource.set(value.source, Boolean(activeBySource.get(value.source)) || value.active);
  }
  return [...activeBySource.entries()].slice(0, limit).map(([source, active]) => ({ source, active }));
}

function epaperTransitiveDepActivity(snapshot: Snapshot | null, now: number) {
  return new Map((snapshot?.pulses ?? []).map((pulse) => [
    pulse.source,
    now < pulse.lastTriggeredAt + pulse.duration,
  ]));
}

function inferEpaperRuleOutputs(ruleName: string, layers: Snapshot["layers"]) {
  const matched = layers.flatMap((layer) => {
    const surfaced = layer.surfaced;
    if (!surfaced) return [];
    const output = surfaced.output as { reason?: unknown; writer?: unknown };
    return output.reason === ruleName || output.writer === ruleName ? [layer.target] : [];
  });
  if (matched.length) return matched;
  return layers.flatMap((layer) => layer.surfaced?.layer === "automation" ? [layer.target] : []);
}

function epaperRuleOutputWrites(rule: Snapshot["rules"][number], layers: Snapshot["layers"]) {
  const writes = Array.isArray(rule.outputWrites) ? rule.outputWrites : [];
  if (writes.length) return writes;
  const outputs = rule.outputs?.length ? rule.outputs : inferEpaperRuleOutputs(rule.name, layers);
  return outputs.map((target) => ({
    target,
    hasOutput: ruleHasEpaperAutomationOpinion(rule.name, layers.find((layer) => layer.target === target)),
  }));
}

function ruleHasEpaperAutomationOpinion(ruleName: string, layer: Snapshot["layers"][number] | undefined) {
  const automationLayer = layer?.layers?.find((item) => item.layer === "automation");
  if (!automationLayer) return layer?.surfaced?.layer === "automation" && layer.surfaced.output.state !== null;
  if (automationLayer.items?.length) {
    return automationLayer.items.some((item) => item.key === ruleName || item.output.writer === ruleName);
  }
  return automationLayer.output.writer === ruleName || automationLayer.output.reason === ruleName;
}

function eventActionHasEpaperOpinion(layer: Snapshot["layers"][number] | undefined) {
  return Boolean(
    layer?.layers?.some((item) => item.layer !== "automation" && item.layer !== "default")
    || (layer?.surfaced && layer.surfaced.layer !== "automation" && layer.surfaced.layer !== "default"),
  );
}

function epaperVisibleFlowOutputs(outputs: string[], targetById: Map<string, Snapshot["targets"][number]>) {
  return outputs.filter((output) => {
    const epaper = targetById.get(output)?.capabilities?.epaper as { excludeFromFlow?: unknown } | undefined;
    return epaper?.excludeFromFlow !== true;
  });
}

function epaperOutputActive(state: unknown) {
  if (state == null) return false;
  if (typeof state === "boolean") return state;
  if (typeof state !== "object") return epaperSourceActive(state);
  const data = state as Record<string, unknown>;
  if ("power" in data) return data.power === "on" || data.power === true;
  if ("position" in data) return data.position === "open" || typeof data.position === "number" && data.position < 95;
  if ("motion" in data) return data.motion !== "stop";
  return false;
}

function prioritizedEpaperSourceIds(automations: Array<{ deps: string[]; outputs: string[] }>, sinkIds: string[], limit: number) {
  const prioritized: string[] = [];
  const depsBySink = sinkIds.map((sink) => uniqueLimited(
    [...automations.filter((automation) => automation.outputs.includes(sink)).flatMap((automation) => automation.deps)]
      .sort(compareEpaperSourcePriority),
    limit,
  ));
  for (let index = 0; index < limit; index += 1) {
    for (const deps of depsBySink) {
      const dep = deps[index];
      if (dep) prioritized.push(dep);
    }
  }
  return uniqueLimited([...prioritized, ...automations.flatMap((automation) => automation.deps)], limit);
}

function compareEpaperSourcePriority(left: string, right: string) {
  return epaperSourcePriority(left) - epaperSourcePriority(right);
}

function epaperSourcePriority(label: string) {
  const lower = label.toLowerCase();
  if (lower.includes(".paddle.") || lower.includes(".button.")) return 0;
  if (lower.endsWith(".presence") || lower.endsWith(".open") || lower.includes(".door.")) return 1;
  if (lower.endsWith(".activelayer")) return 2;
  return 3;
}

function groupEpaperSourceLabels(labels: string[], activeSources: Set<string>) {
  const groups = new Map<string, { key: string; labels: string[]; title: string; detailParts: string[]; active: boolean }>();
  for (const label of labels) {
    const split = splitEpaperFlowNodeLabel(label);
    const rawDetail = epaperFlowNodeRawDetail(label);
    const shouldGroup = split.title.toLowerCase().startsWith("presence") || rawDetail === "activeLayer" || isEpaperEventSourceDetail(rawDetail);
    const key = shouldGroup ? `source:${split.title}` : label;
    const group = groups.get(key) ?? { key, labels: [], title: split.title, detailParts: [], active: false };
    group.labels.push(label);
    group.active ||= activeSources.has(label);
    const groupedDetail = epaperGroupedSourceDetail(rawDetail);
    if (groupedDetail) group.detailParts.push(groupedDetail);
    else if (split.detail) group.detailParts.push(split.detail);
    else if (shouldGroup && rawDetail && !isRedundantEpaperNodeDetail(split.title, rawDetail)) group.detailParts.push(rawDetail);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    labels: group.labels,
    title: group.title,
    detail: truncateMiddle([...new Set(group.detailParts)].join(" / "), 26),
    active: group.active,
  }));
}

function epaperFlowNodeRawDetail(label: string) {
  const [, ...rest] = label.split(".");
  return rest.join(".");
}

function isEpaperEventSourceDetail(detail: string) {
  return detail.startsWith("paddle.") || detail.startsWith("button.");
}

function epaperGroupedSourceDetail(detail: string) {
  const parts = detail.split(".");
  if (parts[0] === "paddle" && parts[1]) return `paddle ${parts[1]}`;
  if (parts[0] === "button" && parts[1]) return `button ${parts[1]}`;
  return "";
}

function splitEpaperFlowNodeLabel(label: string) {
  const [first, ...rest] = label.split(".");
  if (!rest.length) {
    return {
      title: truncateMiddle(label, 16),
      detail: "",
    };
  }
  const detail = rest.join(".");
  if (isRedundantEpaperNodeDetail(first, detail)) {
    return {
      title: truncateMiddle(first || label, 16),
      detail: "",
    };
  }
  return {
    title: truncateMiddle(first || label, 14),
    detail: truncateMiddle(detail, 26),
  };
}

function isRedundantEpaperNodeDetail(title: string, detail: string) {
  const normalizedTitle = title.toLowerCase();
  const normalizedDetail = detail.toLowerCase();
  if (normalizedTitle === normalizedDetail) return true;
  return normalizedDetail === "presence" && normalizedTitle.startsWith("presence");
}

function epaperCurvedPath(sourceX: number, sourceY: number, laneX: number, targetX: number, targetY: number) {
  const direction = targetY >= sourceY ? 1 : -1;
  const verticalGap = Math.abs(targetY - sourceY);
  const horizontalIn = Math.max(0, laneX - sourceX);
  const horizontalOut = Math.max(0, targetX - laneX);
  const c2 = Math.max(2, Math.min(18, horizontalIn / 2, verticalGap / 2));
  const c1 = Math.max(2, Math.min(18, horizontalOut / 2, verticalGap / 2));
  if (verticalGap < 4 || c1 < 3 || c2 < 3) return `M ${sourceX} ${sourceY} L ${laneX} ${sourceY} L ${laneX} ${targetY} L ${targetX} ${targetY}`;
  const sourceSweep = direction > 0 ? 1 : 0;
  const targetSweep = direction > 0 ? 0 : 1;
  return [
    `M ${sourceX} ${sourceY}`,
    `L ${laneX - c2} ${sourceY}`,
    `A ${c2} ${c2} 90 0 ${sourceSweep} ${laneX} ${sourceY + direction * c2}`,
    `L ${laneX} ${targetY - direction * c1}`,
    `A ${c1} ${c1} 90 0 ${targetSweep} ${laneX + c1} ${targetY}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
}

function uniqueLimited(values: string[], limit: number) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function uniqueEdges(edges: Array<{ sourceLabel: string; sinkLabel: string; enabled: boolean }>) {
  const seen = new Map<string, { sourceLabel: string; sinkLabel: string; enabled: boolean }>();
  for (const edge of edges) {
    const key = `${edge.sourceLabel}->${edge.sinkLabel}`;
    const existing = seen.get(key);
    seen.set(key, { ...edge, enabled: edge.enabled || Boolean(existing?.enabled) });
  }
  return [...seen.values()];
}

function uniqueResolvedEpaperEdges(edges: Array<{ sourceLabel: string; sinkLabel: string; enabled: boolean; from: EpaperFlowNode; to: EpaperFlowNode }>) {
  const seen = new Map<string, { sourceLabel: string; sinkLabel: string; enabled: boolean; from: EpaperFlowNode; to: EpaperFlowNode }>();
  for (const edge of edges) {
    const key = `${edge.from.id}->${edge.to.id}`;
    const existing = seen.get(key);
    seen.set(key, { ...edge, enabled: edge.enabled || Boolean(existing?.enabled) });
  }
  return [...seen.values()];
}

function countResolvedEdgesForNode(edges: Array<{ from: EpaperFlowNode; to: EpaperFlowNode }>, nodeId: string, key: "from" | "to") {
  return edges.filter((edge) => edge[key].id === nodeId).length;
}

function indexForResolvedEdgeNode(edges: Array<{ from: EpaperFlowNode; to: EpaperFlowNode }>, nodeId: string, key: "from" | "to", edgeIndex: number) {
  return edges.slice(0, edgeIndex + 1).filter((edge) => edge[key].id === nodeId).length - 1;
}

function countEdgesForLabel(edges: Array<{ sourceLabel: string; sinkLabel: string }>, label: string, key: "sourceLabel" | "sinkLabel") {
  return edges.filter((edge) => edge[key] === label).length;
}

function indexForEdgeLabel(edges: Array<{ sourceLabel: string; sinkLabel: string }>, label: string, key: "sourceLabel" | "sinkLabel", edgeIndex: number) {
  return edges.slice(0, edgeIndex + 1).filter((edge) => edge[key] === label).length - 1;
}

function portOffset(index: number, total: number) {
  if (total <= 1) return 0;
  return (index - (total - 1) / 2) * 4;
}

function epaperStats(snapshot: Snapshot | null, stats: EpaperStatDefinition[], now: number) {
  const sourceById = new Map((snapshot?.sources ?? []).map((source) => [source.source, source]));
  const signalById = new Map((snapshot?.signals ?? []).map((signal) => [signal.id, signal]));
  return stats.map((stat) => {
    const value = formatEpaperStatValue(stat, stat.source ? sourceById.get(stat.source)?.value : signalById.get(stat.signal ?? "")?.value);
    return {
      label: stat.label,
      value: throttledEpaperStatValue(stat, value, now),
    };
  });
}

function epaperPreviewGeneratedAt(displayId: string, fingerprint: string, now: number) {
  const cached = epaperPreviewRenderCache.get(displayId);
  if (cached?.fingerprint === fingerprint) return cached.generatedAt;
  epaperPreviewRenderCache.set(displayId, { fingerprint, generatedAt: now });
  return now;
}

function epaperPreviewFingerprint(snapshot: Snapshot | null, display: EpaperDisplayDefinition, now: number) {
  const roomSnapshot = filterSnapshot(snapshot, display.room);
  const sourceById = new Map((roomSnapshot?.sources ?? []).map((source) => [source.source, source]));
  const signalById = new Map((snapshot?.signals ?? []).map((signal) => [signal.id, signal]));
  const layerByTarget = new Map((roomSnapshot?.layers ?? []).map((layer) => [layer.target, layer]));
  const matter = snapshot?.providers.find((provider) => provider.name === "matter");
  const bindingByKey = new Map((matter?.status?.resolved ?? []).map((binding) => [binding.key, binding]));
  const transitiveDepActiveById = epaperTransitiveDepActivity(snapshot, now);
  return stableStringify({
    display: display.id,
    stats: epaperStats(snapshot, display.stats ?? [], now),
    devices: visibleDeviceTargets(roomSnapshot?.targets ?? []).map((target) => {
      const layer = layerByTarget.get(target.target);
      const binding = bindingByKey.get(target.key) ?? bindingByKey.get(target.target);
      return {
        target: target.target,
        key: target.key,
        label: deviceResolvedLabel(target, binding?.label),
        available: binding?.available,
        statusSources: epaperStatusSourceIds(target).map((source) => [source, sourceById.get(source)?.value]),
        status: layer?.surfaced?.output.state,
        layer: layer?.surfaced?.layer,
      };
    }),
    rules: (roomSnapshot?.rules ?? []).map((rule) => ({
      name: rule.name,
      enabled: rule.enabled,
      deps: rule.deps,
      causes: rule.causes,
      outputs: rule.outputs,
      depValues: rule.deps
        .flatMap((dep) => expandEpaperSourceDeps(dep, signalById, sourceById, transitiveDepActiveById))
        .map((dep) => [dep.source, sourceById.get(dep.source)?.value, dep.active]),
    })),
    events: (roomSnapshot?.eventActions ?? []).map((action) => ({
      name: action.name,
      event: action.event,
      outputs: action.outputs,
      active: Boolean(action.lastRunAt && now - action.lastRunAt <= 5 * 60 * 1000),
    })),
    signals: (roomSnapshot?.signals ?? []).map((signal) => ({
      id: signal.id,
      value: signal.value,
      deps: signal.deps,
    })),
    layers: (roomSnapshot?.layers ?? []).map((layer) => ({
      target: layer.target,
      surfaced: layer.surfaced
        ? {
            layer: layer.surfaced.layer,
            state: layer.surfaced.output.state,
            reason: layer.surfaced.output.reason,
          }
        : undefined,
    })),
  });
}

function epaperStatusSourceIds(target: Snapshot["targets"][number]) {
  return [
    target.display?.status?.source,
    `${target.key}.status`,
    `${target.key}.power`,
    `${target.key}.displayStatus`,
    `${target.key}.presence`,
    `${target.key}.open`,
    `${target.key}.position`,
  ].filter((source): source is string => Boolean(source));
}

function epaperImageVersion(snapshot: Snapshot, room: string, renderNow: number) {
  const roomSnapshot = filterSnapshot(snapshot, room);
  const latestSource = Math.max(0, ...(roomSnapshot?.sources ?? []).map((source) => source.updatedAt ?? source.since ?? 0));
  const latestSignal = Math.max(0, ...(roomSnapshot?.signals ?? []).map((signal) => signal.lastRunAt ?? 0));
  const latestRule = Math.max(0, ...(roomSnapshot?.rules ?? []).map((rule) => rule.lastRunAt ?? 0));
  const latestLayer = Math.max(0, ...(roomSnapshot?.layers ?? []).map((layer) => layer.surfaced?.since ?? 0));
  const providerStamp = Math.max(0, ...snapshot.providers.map((provider) => provider.status?.lastMessageAt ?? 0));
  return String(Math.max(renderNow, latestSource, latestSignal, latestRule, latestLayer, providerStamp));
}

function epaperPreviewUrl(displayId: string, version: string | number) {
  const query = new URLSearchParams({
    palette: "grayscale",
    v: String(version),
  });
  return `/api/epaper/${encodeURIComponent(displayId)}.png?${query.toString()}`;
}

function epaperPreviewUrlFromRenderEvent(message: EpaperRenderEvent) {
  const [path, rawQuery = ""] = message.url.split("?");
  const query = new URLSearchParams(rawQuery);
  query.set("palette", "grayscale");
  query.set("v", String(message.generatedAt));
  return `${path}?${query.toString()}`;
}

function formatEpaperStatValue(stat: EpaperStatDefinition, value: unknown) {
  if (stat.format === "day-night") return typeof value === "boolean" ? (value ? "DAY" : "NIGHT") : "--";
  if (typeof value !== "number") return "--";
  const formatted = stat.format === "integer" ? String(Math.round(value)) : String(value);
  return `${formatted}${stat.unit ?? ""}`;
}

function throttledEpaperStatValue(stat: EpaperStatDefinition, value: string, now: number) {
  if (!stat.minUpdateMs) return value;
  const key = stat.source ?? stat.signal ?? stat.label;
  const cached = epaperStatValueCache.get(key);
  if (!cached || now - cached.updatedAt >= stat.minUpdateMs) {
    epaperStatValueCache.set(key, { value, updatedAt: now });
    return value;
  }
  return cached.value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortStable(item)]));
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

function deviceResolvedLabel(target: Snapshot["targets"][number], bindingLabel?: string) {
  const displayName = target.capabilities?.displayName;
  return typeof displayName === "string" && displayName.length > 0 ? displayName : bindingLabel || target.key;
}

function epaperFlowLabel(id: string, room: string, length: number) {
  return truncateMiddle(stripRoomPrefix(id, room), length);
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

function deviceProviderHealth(
  target: Snapshot["targets"][number],
  matter: Snapshot["providers"][number] | undefined,
  binding: MatterResolvedBinding | undefined,
) {
  if (target.provider !== "matter") return { label: target.provider, tone: "ok" };
  return matterHealth(matter, binding);
}

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
  const matterLog = (snapshot.matterLog ?? []).filter((entry) => (
    inRoom(entry.subject) ||
    (entry.key ? inRoom(entry.key) : false) ||
    (entry.event ? inRoom(entry.event) : false) ||
    (entry.reason ? inRoom(entry.reason) : false)
  ));
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
      (entry.key ? deps.has(entry.key) || outputs.has(entry.key) : false) ||
      (entry.event ? deps.has(entry.event) || outputs.has(entry.event) : false)
    );
  };
  const matterLog = (snapshot.matterLog ?? []).filter((entry) => {
    const deviceMatches = (
      deviceFilter === "all" ||
      matchesDevice(entry.subject) ||
      (entry.key ? matchesDevice(entry.key) : false) ||
      (entry.event ? matchesDevice(entry.event) : false)
    );
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
  const label = layerOutputLabel(layer.output);
  return <div className="truncate text-xs text-gaia-muted" title={label}>{label}</div>;
}

function LayerBadge({ layer }: { layer?: string }) {
  if (!layer) return null;
  const color = layer === "automation" ? "bg-gaia-green/30" : layer === "webOverride" || layer === "override" ? "bg-gaia-yellow" : "bg-gaia-paper";
  return <span className={`gaia-chip ${color}`}>{layer}</span>;
}

function layerOutputLabel(output: { state?: unknown; reason?: unknown; writer?: unknown }) {
  if (typeof output.reason === "string" && output.reason) {
    return output.reason;
  }
  if (typeof output.writer === "string" && output.writer) {
    return output.writer;
  }
  return formatValue(output.state);
}

function formatRunTime(value?: number, minuteOnly = false) {
  if (!value) return "never";
  if (minuteOnly) {
    const minutes = Math.max(0, Math.floor((floorToMinute(Date.now()) - floorToMinute(value)) / 60_000));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
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
  if (entry.kind === "ping") {
    const parts = [
      entry.ok === false ? "failed" : "ok",
      entry.elapsedMs !== undefined ? `${Math.round(entry.elapsedMs)}ms` : undefined,
      entry.error,
    ].filter(Boolean);
    return parts.join(" · ");
  }
  if (entry.kind === "probe") {
    const reads = Array.isArray(entry.value) ? `${entry.value.length} reads` : undefined;
    const parts = [
      entry.ok === false ? "failed" : "ok",
      reads,
      entry.elapsedMs !== undefined ? `${Math.round(entry.elapsedMs)}ms` : undefined,
      entry.error,
    ].filter(Boolean);
    return parts.join(" · ");
  }
  if (entry.kind === "event") {
    const parts = [
      entry.eventName ?? (entry.eventId !== undefined ? `event ${entry.eventId}` : "event"),
      entry.endpoint !== undefined ? `ep ${entry.endpoint}` : undefined,
      entry.event ?? "no rule event",
    ].filter(Boolean);
    return parts.join(" · ");
  }
  const source = entry.property ? `${entry.key ?? entry.subject}.${entry.property}` : entry.key ?? entry.subject;
  return `${source} = ${formatValue(entry.value)}`;
}

function formatValue(value: unknown) {
  if (value === undefined) return "unknown";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function formatEpaperTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(floorToMinute(value));
}

function floorToMinute(value: number) {
  return Math.floor(value / 60_000) * 60_000;
}

function truncateText(value: string, length: number) {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1))}...`;
}

function truncateMiddle(value: string, length: number) {
  if (value.length <= length) return value;
  const keep = Math.max(2, Math.floor((length - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
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
