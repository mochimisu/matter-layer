import cors from "cors";
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config/config";
import { MatterProvider } from "./providers/matter/provider";
import { MatterLayerRuntime } from "./runtime/engine";
import { loadRulesModule } from "./runtime/load";
import type { RuntimeEvent } from "./runtime/types";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const config = loadConfig();
  const runtime = new MatterLayerRuntime({ dryRun: config.dryRun });
  runtime.loadModules(await loadRulesModule(config.rulesModule));
  runtime.registerProvider(
    new MatterProvider({
      url: config.matterWsUrl,
      dryRun: config.dryRun,
      enabled: config.matterEnabled,
      bindings: config.matterBindings,
    }),
  );
  await runtime.start();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/status", (_req, res) => {
    res.json({
      ok: true,
      dryRun: config.dryRun,
      matter: {
        enabled: config.matterEnabled,
        url: config.matterWsUrl,
        bindingCount: Object.keys(config.matterBindings).length,
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
    res.json(runtime.snapshot());
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
    const { source, value } = req.body ?? {};
    if (typeof source !== "string") {
      res.status(400).json({ error: "source is required" });
      return;
    }
    runtime.updateSource({
      source,
      value,
      provider: "fake",
      observedAt: Date.now(),
    });
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

  app.use(express.static(join(rootDir, "dist/web")));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/") || req.path === "/events") {
      next();
      return;
    }
    res.sendFile(join(rootDir, "dist/web/index.html"));
  });

  const server = app.listen(config.port, () => {
    console.log(`matter-layer API listening on http://127.0.0.1:${config.port}`);
  });

  const wss = new WebSocketServer({ server, path: "/events" });
  let eventSeq = 0;
  wss.on("connection", (client) => {
    client.send(
      JSON.stringify({
        type: "snapshot",
        seq: eventSeq,
        snapshot: runtime.snapshot(),
      }),
    );
  });
  runtime.onEvent((event) => {
    const delta = deltaForEvent(runtime, event);
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
            },
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
              lastRunAt: rule.lastRunAt,
              lastError: rule.lastError,
            },
          }
        : { type: "event" };
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
      };
    case "device.event":
      return { type: "event" };
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
