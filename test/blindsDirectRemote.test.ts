import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bilresaBlinds } from "../src/devices/bilresa";
import { smartwings, smartwingsGroup } from "../src/devices/smartwings";
import { defineRoomDevices, defineRoomRules } from "../src/runtime/dsl";
import { MatterLayerRuntime } from "../src/runtime/engine";
import { remote } from "../src/runtime/devices";

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("direct blind remote inference", () => {
  it("defaults blinds to open", async () => {
    const runtime = new MatterLayerRuntime({ dryRun: true });
    runtime.loadModules({
      devices: [
        defineRoomDevices("office", ({ room }) => {
          room.blinds = smartwings("office.blinds");
        }),
      ],
      rules: [],
    });
    await runtime.start();

    expect(runtime.layers.surface("office.blinds")).toMatchObject({
      layer: "default",
      output: {
        state: { position: "open" },
        reason: "Cover idle",
      },
    });
    runtime.stop();
  });

  it("translates a BILRESA press into the blinds manual input layer", async () => {
    const runtime = buildRuntime();
    await runtime.start();

    runtime.dispatchEvent("office.blindsRemote.button.1.initialPress");
    await tick();

    expect(runtime.layers.surface("office.blinds")).toMatchObject({
      layer: "override",
      output: {
        state: { position: "open" },
        reason: "Manual blind input",
        writer: "manual",
        expiresAt: expect.any(Number),
      },
    });
    expect(runtime.commandResults.at(-1)?.command).toMatchObject({
      target: "office.blinds",
      state: { position: "open" },
    });

    runtime.stop();
  });

  it("persists BILRESA manual blind input across runtime restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matter-layer-blinds-"));
    const dbPath = join(dir, "overrides.sqlite");
    try {
      const first = buildRuntime(dbPath);
      await first.start();

      first.dispatchEvent("office.blindsRemote.button.1.initialPress");
      await tick();
      first.stop();

      const second = buildRuntime(dbPath);
      await second.start();

      expect(second.layers.surface("office.blinds")).toMatchObject({
        layer: "override",
        output: {
          state: { position: "open" },
          reason: "Manual blind input",
          writer: "manual",
          expiresAt: expect.any(Number),
        },
      });
      second.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("translates a direct opening position delta into the blinds manual input layer", async () => {
    const runtime = buildRuntime();
    await runtime.start();

    runtime.updateSource({
      source: "office.blinds.position",
      value: 70,
      provider: "matter",
      observedAt: Date.now(),
    });
    await tick();

    expect(runtime.layers.surface("office.blinds")).toMatchObject({
      layer: "default",
      output: {
        state: { position: "open" },
        reason: "Cover idle",
      },
    });

    runtime.updateSource({
      source: "office.blinds.position",
      value: 60,
      provider: "matter",
      observedAt: Date.now(),
    });
    await tick();

    expect(runtime.layers.surface("office.blinds")).toMatchObject({
      layer: "override",
      output: {
        state: { position: "open" },
        reason: "Manual blind input",
        writer: "manual",
        expiresAt: expect.any(Number),
      },
    });
    expect(runtime.commandResults.at(-1)?.command).toMatchObject({
      target: "office.blinds",
      state: { position: "open" },
    });

    runtime.stop();
  });

  it("translates a direct closing position delta into the blinds manual input layer", async () => {
    const runtime = buildRuntime();
    await runtime.start();

    runtime.updateSource({
      source: "office.blinds.position",
      value: 20,
      provider: "matter",
      observedAt: Date.now(),
    });
    runtime.updateSource({
      source: "office.blinds.position",
      value: 35,
      provider: "matter",
      observedAt: Date.now(),
    });
    await tick();

    expect(runtime.layers.surface("office.blinds")).toMatchObject({
      layer: "override",
      output: {
        state: { position: "closed" },
        reason: "Manual blind input",
        writer: "manual",
        expiresAt: expect.any(Number),
      },
    });
    expect(runtime.commandResults.at(-1)?.command).toMatchObject({
      target: "office.blinds",
      state: { position: "closed" },
    });

    runtime.stop();
  });
});

function buildRuntime(overrideDbPath?: string) {
  const runtime = new MatterLayerRuntime({ dryRun: true, overrideDbPath });
  runtime.loadModules({
    devices: [
      defineRoomDevices("office", ({ room }) => {
        room.blindsRemote = remote("office.blindsRemote");
        room.blinds = smartwingsGroup(["office.blinds"]);
      }),
    ],
    rules: [
      defineRoomRules("office", ({ room }) => {
        bilresaBlinds(room.blindsRemote, room.blinds);
      }),
    ],
  });
  return runtime;
}
