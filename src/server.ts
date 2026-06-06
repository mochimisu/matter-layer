import cors from "cors";
import express from "express";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config/config";
import { getEpaperRenderState, parseEpaperRenderOptions, renderRoomEpaperPanelPng, renderRoomEpaperPanelSvg, type EpaperRenderOptions, type EpaperRenderState } from "./epaper";
import { HomeAssistantProvider } from "./providers/homeAssistant/provider";
import { MatterProvider } from "./providers/matter/provider";
import { MatterLayerRuntime } from "./runtime/engine";
import { loadRulesModule } from "./runtime/load";
import type { RuntimeEvent } from "./runtime/types";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const config = loadConfig();
  const runtime = new MatterLayerRuntime({ dryRun: config.dryRun, overrideDbPath: config.dbPath });
  runtime.loadModules(await loadRulesModule(config.rulesModule));
  const matterProvider = new MatterProvider({
    url: config.matterWsUrl,
    dryRun: config.dryRun,
    enabled: config.matterEnabled,
    bindings: config.matterBindings,
  });
  runtime.registerProvider(matterProvider);
  runtime.registerProvider(new HomeAssistantProvider({
    url: config.haWsUrl,
    token: config.haToken,
    enabled: config.haEnabled,
  }));
  await runtime.start();

  const app = express();
  app.use(cors());
  app.use(express.json());
  const sourceOverrides = new Map<string, { previous: unknown; timeout?: NodeJS.Timeout }>();

  app.get("/api/status", (_req, res) => {
    res.json({
      ok: true,
      dryRun: config.dryRun,
      matter: {
        enabled: config.matterEnabled,
        url: config.matterWsUrl,
        bindingCount: Object.keys(config.matterBindings).length,
      },
      ha: {
        enabled: config.haEnabled,
        url: config.haWsUrl,
        tokenConfigured: Boolean(config.haToken),
      },
      counts: {
        sources: runtime.sources.size,
        targets: runtime.targets.size,
        rules: runtime.rules.size,
      },
      providers: runtime.snapshot().providers,
    });
  });

  app.get("/api/snapshot", (_req, res) => {
    res.json(runtime.snapshot());
  });

  app.get("/api/devices", (_req, res) => {
    const snapshot = runtime.snapshot();
    res.json({
      sources: snapshot.sources,
      targets: snapshot.targets,
      layers: snapshot.layers,
    });
  });

  app.get("/api/automations", (_req, res) => {
    res.json(runtime.snapshot().rules);
  });

  app.get("/api/graph", (_req, res) => {
    res.json(runtime.graph());
  });

  app.get("/api/epaper/office.svg", (req, res) => {
    const svg = renderRoomEpaperPanelSvg(runtime.snapshot(), { ...parseEpaperRenderOptions(req.query), room: "office" });
    res.setHeader("Cache-Control", "no-store");
    res.type("image/svg+xml").send(svg);
  });

  app.get("/api/epaper/office.png", async (req, res) => {
    try {
      const png = await renderRoomEpaperPanelPng(runtime.snapshot(), { ...parseEpaperRenderOptions(req.query), room: "office" });
      res.setHeader("Cache-Control", "no-store");
      res.type("image/png").send(png);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/epaper/:room.svg", (req, res) => {
    const svg = renderRoomEpaperPanelSvg(runtime.snapshot(), { ...parseEpaperRenderOptions(req.query), room: req.params.room });
    res.setHeader("Cache-Control", "no-store");
    res.type("image/svg+xml").send(svg);
  });

  app.get("/api/epaper/:room.png", async (req, res) => {
    try {
      const png = await renderRoomEpaperPanelPng(runtime.snapshot(), { ...parseEpaperRenderOptions(req.query), room: req.params.room });
      res.setHeader("Cache-Control", "no-store");
      res.type("image/png").send(png);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/devices/:target/web-override", (req, res) => {
    const target = req.params.target;
    if (!runtime.targets.has(target)) {
      res.status(404).json({ error: "unknown target" });
      return;
    }
    const { state, ttl, reason } = req.body ?? {};
    runtime.setWebOverride(target, state ?? null, {
      ttl: typeof ttl === "string" && ttl.length > 0 ? ttl : undefined,
      reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
    });
    res.json(runtime.snapshot());
  });

  app.delete("/api/devices/:target/web-override", (req, res) => {
    runtime.clearLayer(req.params.target, "webOverride");
    runtime.clearLayer(req.params.target, "override");
    res.json(runtime.snapshot());
  });

  app.post("/api/devices/:target/matter-ping", async (req, res) => {
    const target = req.params.target;
    if (!runtime.targets.has(target)) {
      res.status(404).json({ error: "unknown target" });
      return;
    }
    try {
      const result = await matterProvider.pingTarget(target);
      res.json({ result, snapshot: runtime.snapshot() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/devices/:target/matter-probe", async (req, res) => {
    const target = req.params.target;
    if (!runtime.targets.has(target)) {
      res.status(404).json({ error: "unknown target" });
      return;
    }
    try {
      const result = await matterProvider.probeTarget(target);
      res.json({ result, snapshot: runtime.snapshot() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/matter/refresh", async (_req, res) => {
    try {
      const result = await matterProvider.refreshNodes();
      res.json({ result, snapshot: runtime.snapshot() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/automations/:name", (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    if (!runtime.setRuleEnabled(req.params.name, enabled)) {
      res.status(404).json({ error: "unknown automation" });
      return;
    }
    res.json(runtime.snapshot());
  });

  app.post("/api/apply-current", async (req, res) => {
    const room = typeof req.body?.room === "string" ? req.body.room : undefined;
    const results = await runtime.forceApplyCurrent({ room });
    res.json({ applied: results.length, results, snapshot: runtime.snapshot() });
  });

  app.post("/api/test/event", (req, res) => {
    const { event } = req.body ?? {};
    if (typeof event !== "string") {
      res.status(400).json({ error: "event is required" });
      return;
    }
    const handled = runtime.dispatchEvent(event);
    res.json({ handled, snapshot: runtime.snapshot() });
  });

  app.post("/api/test/source", (req, res) => {
    const { source, value, ttl } = req.body ?? {};
    if (typeof source !== "string") {
      res.status(400).json({ error: "source is required" });
      return;
    }
    const binding = runtime.sources.get(source);
    if (!binding) {
      res.status(404).json({ error: "unknown source" });
      return;
    }
    const previous = binding.peek();
    const existing = sourceOverrides.get(source);
    if (existing?.timeout) {
      clearTimeout(existing.timeout);
    }
    const restoreValue = existing ? existing.previous : previous;
    let duration: number | undefined;
    if (typeof ttl === "string" && ttl.length > 0) {
      const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(ttl.trim());
      if (!match) {
        res.status(400).json({ error: "invalid ttl" });
        return;
      }
      const amount = Number(match[1]);
      const unit = match[2];
      duration = unit === "ms" ? amount : unit === "s" ? amount * 1000 : unit === "m" ? amount * 60_000 : amount * 3_600_000;
    }
    runtime.updateSource({
      source,
      value,
      provider: "fake",
      observedAt: Date.now(),
    });
    const override: { previous: unknown; timeout?: NodeJS.Timeout } = { previous: restoreValue };
    if (duration !== undefined) {
      const timeout = setTimeout(() => {
        sourceOverrides.delete(source);
        runtime.updateSource({
          source,
          value: restoreValue,
          provider: "fake",
          observedAt: Date.now(),
        });
      }, duration);
      override.timeout = timeout;
    }
    sourceOverrides.set(source, override);
    res.json(runtime.snapshot());
  });

  app.delete("/api/test/source/:source/override", (req, res) => {
    const source = req.params.source;
    const binding = runtime.sources.get(source);
    if (!binding) {
      res.status(404).json({ error: "unknown source" });
      return;
    }
    const existing = sourceOverrides.get(source);
    if (existing?.timeout) {
      clearTimeout(existing.timeout);
    }
    sourceOverrides.delete(source);
    if (existing) {
      runtime.updateSource({
        source,
        value: existing.previous,
        provider: "fake",
        observedAt: Date.now(),
      });
    }
    res.json(runtime.snapshot());
  });

  app.post("/api/test/source/:source/toggle", (req, res) => {
    const source = req.params.source;
    const binding = runtime.sources.get(source);
    if (!binding) {
      res.status(404).json({ error: "unknown source" });
      return;
    }
    const current = binding.peek();
    const value = typeof current === "boolean" ? !current : current ? false : true;
    runtime.updateSource({
      source,
      value,
      provider: "fake",
      observedAt: Date.now(),
    });
    res.json(runtime.snapshot());
  });

  if (process.env.MATTER_LAYER_WEB_DEV === "1") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: join(rootDir, "web"),
      appType: "custom",
      server: {
        middlewareMode: true,
        allowedHosts: true,
      },
    });
    app.use((req, res, next) => {
      if (!req.path.startsWith("/api/") && req.path !== "/events") {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Matter-Layer-Web-Dev", "1");
      }
      next();
    });
    app.use(vite.middlewares);
    app.use(async (req, res, next) => {
      if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api/") || req.path === "/events") {
        next();
        return;
      }
      try {
        const template = await readFile(join(rootDir, "web/index.html"), "utf8");
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).type("html").send(html);
      } catch (error) {
        if (error instanceof Error) {
          vite.ssrFixStacktrace(error);
        }
        next(error);
      }
    });
  } else {
    const webDistDir = join(rootDir, "dist/web");
    app.use(
      express.static(webDistDir, {
        setHeaders(res, path) {
          if (path.endsWith("index.html")) {
            res.setHeader("Cache-Control", "no-store");
          }
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/") || req.path === "/events") {
        next();
        return;
      }
      if (req.path.startsWith("/assets/")) {
        res.status(404).type("text/plain").send("Not found");
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(join(webDistDir, "index.html"));
    });
  }

  const server = app.listen(config.port, () => {
    console.log(`matter-layer API listening on http://127.0.0.1:${config.port}`);
  });

  const wss = new WebSocketServer({ noServer: true });
  const epaperWss = new WebSocketServer({ noServer: true });
  let eventSeq = 0;
  let epaperSeq = 0;
  const epaperClients = new Map<WebSocket, { options: EpaperRenderOptions; state: EpaperRenderState }>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/events") {
      wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
      return;
    }
    if (url.pathname === "/epaper-events" || url.pathname.startsWith("/epaper-events/")) {
      epaperWss.handleUpgrade(req, socket, head, (client) => epaperWss.emit("connection", client, req));
      return;
    }
    socket.destroy();
  });

  wss.on("connection", (client) => {
    client.send(
      JSON.stringify({
        type: "snapshot",
        seq: eventSeq,
        snapshot: runtime.snapshot(),
      }),
    );
  });

  epaperWss.on("connection", (client, req) => {
    const options = epaperRenderOptionsFromRequest(req);
    const state = getEpaperRenderState(runtime.snapshot(), options);
    epaperClients.set(client, { options, state });
    client.send(JSON.stringify(epaperEventPayload("epaper.snapshot", ++epaperSeq, state, options)));
    client.on("close", () => {
      epaperClients.delete(client);
    });
  });

  const broadcastEpaperUpdates = (event: RuntimeEvent | { type: "epaper.tick" }) => {
    if (epaperClients.size === 0) return;
    const snapshot = runtime.snapshot();
    for (const [client, subscription] of epaperClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const state = getEpaperRenderState(snapshot, subscription.options);
      if (state.fingerprint === subscription.state.fingerprint) continue;
      subscription.state = state;
      client.send(JSON.stringify({
        ...epaperEventPayload("epaper.update", ++epaperSeq, state, subscription.options),
        event,
      }));
    }
  };

  const epaperTick = setInterval(() => {
    broadcastEpaperUpdates({ type: "epaper.tick" });
  }, 60_000);
  epaperTick.unref?.();

  runtime.onEvent((event) => {
    const delta = deltaForEvent(runtime, event);
    broadcastEpaperUpdates(event);
    if (!delta) {
      return;
    }
    const data = JSON.stringify({
      type: delta.type === "event" ? "event" : "delta",
      seq: ++eventSeq,
      event,
      ...(delta.type === "event" ? {} : { delta }),
    });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  });
}

void main();

function epaperRenderOptionsFromRequest(req: IncomingMessage): EpaperRenderOptions {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const options = parseEpaperRenderOptions(Object.fromEntries(url.searchParams.entries()));
  const pathPrefix = "/epaper-events/";
  const pathRoom = url.pathname.startsWith(pathPrefix) ? decodeURIComponent(url.pathname.slice(pathPrefix.length)) : undefined;
  return {
    ...options,
    room: pathRoom && pathRoom.length > 0 ? pathRoom : options.room,
  };
}

function epaperEventPayload(type: "epaper.snapshot" | "epaper.update", seq: number, state: EpaperRenderState, options: EpaperRenderOptions) {
  return {
    type,
    seq,
    display: state.displayId,
    room: state.room,
    title: state.title,
    width: state.width,
    height: state.height,
    palette: state.palette,
    fingerprint: state.fingerprint,
    generatedAt: state.generatedAt,
    url: epaperImageUrl(state, options),
  };
}

function epaperImageUrl(state: EpaperRenderState, options: EpaperRenderOptions) {
  const query = new URLSearchParams();
  query.set("palette", state.palette);
  query.set("width", String(state.width));
  query.set("height", String(state.height));
  if (options.profile) query.set("profile", options.profile);
  if (options.title) query.set("title", options.title);
  return `/api/epaper/${encodeURIComponent(state.displayId)}.png?${query.toString()}`;
}

function deltaForEvent(runtime: MatterLayerRuntime, event: RuntimeEvent) {
  switch (event.type) {
    case "source.changed": {
      if (event.update.source === "time.tick") {
        return null;
      }
      const source = runtime.sources.get(event.update.source);
      return source
        ? {
            type: "source",
            source: {
              ...source.binding,
              value: source.peek(),
              since: source.since(),
              updatedAt: source.updated(),
            },
            log: event.update.provider === "matter" ? runtime.matterLog.at(-1) : undefined,
          }
        : { type: "event" };
    }
    case "signal.changed": {
      const signal = runtime.signals.get(event.id);
      return signal
        ? {
            type: "signal",
            signal: {
              id: signal.id,
              value: signal.peek(),
              deps: [...signal.registration.deps],
              initialized: signal.registration.initialized,
              lastRunAt: signal.registration.lastRunAt,
            },
            pulses: runtime.snapshot().pulses,
          }
        : { type: "event" };
    }
    case "rule.run": {
      const rule = runtime.rules.get(event.name);
      return rule
        ? {
            type: "rule",
            rule: {
              name: rule.name,
              enabled: rule.enabled,
              deps: [...rule.deps],
              outputs: [...rule.outputs],
              outputWrites: [...rule.outputWrites.entries()].map(([target, hasOutput]) => ({ target, hasOutput })),
              lastRunAt: rule.lastRunAt,
              lastError: rule.lastError,
            },
          }
        : { type: "event" };
    }
    case "provider.changed": {
      const provider = runtime.snapshot().providers.find((item) => item.name === event.provider);
      return provider ? { type: "provider", provider } : { type: "event" };
    }
    case "layer.changed":
      return {
        type: "layer",
        layer: layerSnapshotForTarget(runtime, event.target),
      };
    case "command":
      return {
        type: "command",
        command: event.result,
        log: runtime.matterLog.at(-1),
      };
    case "device.event":
      return { type: "event" };
    case "matter.log":
      return { type: "matterLog", log: event.log };
  }
}

function layerSnapshotForTarget(runtime: MatterLayerRuntime, target: string) {
  return (
    runtime.layers.snapshot().find((layer) => layer.target === target) ?? {
      target,
      layers: [],
      surfaced: null,
    }
  );
}
