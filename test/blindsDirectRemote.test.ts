import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bilresaBlinds } from "../src/devices/bilresa";
import { smartwings, smartwingsGroup } from "../src/devices/smartwings";
import { FakeProvider } from "../src/providers/fake/provider";
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
      },
    });
    expect(runtime.layers.surface("office.blinds")?.output.expiresAt).toBeUndefined();
    expect(runtime.commandResults.at(-1)?.command).toMatchObject({
      target: "office.blinds",
      state: { position: "open" },
    });

    runtime.stop();
  });

  it("clears a matching BILRESA blind override on repeated press", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00-07:00"));
    const runtime = buildRuntime();
    try {
      await runtime.start();

      runtime.dispatchEvent("office.blindsRemote.button.1.initialPress");
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.layers.surface("office.blinds")).toMatchObject({
        layer: "override",
        output: {
          state: { position: "open" },
          writer: "manual",
        },
      });

      await vi.advanceTimersByTimeAsync(2500);
      runtime.dispatchEvent("office.blindsRemote.button.1.initialPress");
      await vi.advanceTimersByTimeAsync(0);

      expect(runtime.layers.surface("office.blinds")).toMatchObject({
        layer: "default",
        output: {
          state: { position: "open" },
        },
      });

      expect(runtime.commandResults.find((result) =>
        result.command.target === "office.blinds" && result.command.state?.motion === "stop"
      )).toBeUndefined();
    } finally {
      runtime.stop();
      vi.useRealTimers();
    }
  });

  it("keeps automation movement from recreating a cleared manual override", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00-07:00"));
    const { runtime, matter } = buildSimulatedRuntime();
    try {
      await runtime.start();
      runtime.writeLayer("office.blinds", "automation", {
        state: { position: "closed" },
        reason: "office.blinds",
        writer: "office.blinds",
      }, "office.blinds");

      runtime.dispatchEvent("office.blindsRemote.button.1.initialPress");
      await vi.advanceTimersByTimeAsync(0);
      matter.emit("office.blinds.position", 20);

      runtime.dispatchEvent("office.blindsRemote.button.1.initialPress");
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.layers.surface("office.blinds")).toMatchObject({
        layer: "automation",
        output: { state: { position: "closed" } },
      });
      expect(matter.commands.at(-1)).toMatchObject({
        target: "office.blinds",
        state: { position: "closed" },
      });

      await vi.advanceTimersByTimeAsync(9000);
      matter.emit("office.blinds.position", 35);
      await vi.advanceTimersByTimeAsync(0);

      expect(runtime.layers.surface("office.blinds")).toMatchObject({
        layer: "automation",
        output: {
          state: { position: "closed" },
          reason: "office.blinds",
          writer: "office.blinds",
        },
      });
      expect(runtime.layers.layer("office.blinds", "override")).toBeUndefined();
    } finally {
      runtime.stop();
      vi.useRealTimers();
    }
  });

  it("keeps manual blind input until it is explicitly changed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00-07:00"));
    const runtime = buildRuntime();
    try {
      await runtime.start();
      runtime.dispatchEvent("office.blindsRemote.button.2.initialPress");
      await vi.advanceTimersByTimeAsync(0);

      expect(runtime.layers.surface("office.blinds")).toMatchObject({
        layer: "override",
        output: {
          state: { position: "closed" },
          reason: "Manual blind input",
          writer: "manual",
        },
      });
      expect(runtime.layers.surface("office.blinds")?.output.expiresAt).toBeUndefined();

      vi.setSystemTime(new Date("2026-07-16T12:00:00-07:00"));
      expect(runtime.layers.expire("office.blinds", Date.now())).toEqual([]);
      expect(runtime.layers.surface("office.blinds")).toMatchObject({
        layer: "override",
        output: { state: { position: "closed" } },
      });
    } finally {
      runtime.stop();
      vi.useRealTimers();
    }
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
        },
      });
      expect(second.layers.surface("office.blinds")?.output.expiresAt).toBeUndefined();
      second.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates an existing expiring manual input to persistent policy on restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matter-layer-blinds-policy-"));
    const dbPath = join(dir, "overrides.sqlite");
    try {
      const first = buildRuntime(dbPath);
      await first.start();
      first.writeLayer("office.blinds", "override", {
        state: { position: "closed" },
        layer: "override",
        reason: "Manual blind input",
        writer: "manual",
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      await tick();
      expect(first.layers.surface("office.blinds")?.output.expiresAt).toEqual(expect.any(Number));
      first.stop();

      const second = buildRuntime(dbPath);
      await second.start();
      await tick();

      expect(second.layers.surface("office.blinds")).toMatchObject({
        layer: "override",
        output: {
          state: { position: "closed" },
          reason: "Manual blind input",
          writer: "manual",
        },
      });
      expect(second.layers.surface("office.blinds")?.output.expiresAt).toBeUndefined();
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
      },
    });
    expect(runtime.layers.surface("office.blinds")?.output.expiresAt).toBeUndefined();
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
      },
    });
    expect(runtime.layers.surface("office.blinds")?.output.expiresAt).toBeUndefined();
    expect(runtime.commandResults.at(-1)?.command).toMatchObject({
      target: "office.blinds",
      state: { position: "closed" },
    });

    runtime.stop();
  });

  it("does not reinterpret automation movement as manual blind input", async () => {
    const runtime = buildRuntime();
    await runtime.start();

    runtime.updateSource({
      source: "office.blinds.position",
      value: 20,
      provider: "matter",
      observedAt: Date.now(),
    });
    runtime.writeLayer("office.blinds", "automation", {
      state: { position: "closed" },
      reason: "office.blinds",
      writer: "office.blinds",
    }, "office.blinds");
    runtime.enqueueApply("office.blinds");
    await tick();

    runtime.updateSource({
      source: "office.blinds.position",
      value: 35,
      provider: "matter",
      observedAt: Date.now(),
    });
    await tick();

    expect(runtime.layers.surface("office.blinds")).toMatchObject({
      layer: "automation",
      output: {
        state: { position: "closed" },
        reason: "office.blinds",
        writer: "office.blinds",
      },
    });
    expect(runtime.layers.layer("office.blinds", "override")).toBeUndefined();

    runtime.stop();
  });

  it("does not reinterpret web override movement as manual blind input", async () => {
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
      },
    });

    runtime.setWebOverride("office.blinds", { position: "closed" }, { reason: "Web override" });
    await tick();
    expect(runtime.layers.surface("office.blinds")).toMatchObject({
      layer: "override",
      output: {
        state: { position: "closed" },
        reason: "Web override",
        writer: "web",
      },
    });

    runtime.updateSource({
      source: "office.blinds.position",
      value: 40,
      provider: "matter",
      observedAt: Date.now(),
    });
    runtime.updateSource({
      source: "office.blinds.position",
      value: 55,
      provider: "matter",
      observedAt: Date.now(),
    });
    await tick();

    expect(runtime.layers.surface("office.blinds")).toMatchObject({
      layer: "override",
      output: {
        state: { position: "closed" },
        reason: "Web override",
        writer: "web",
      },
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

function buildSimulatedRuntime() {
  const runtime = buildRuntime();
  const matter = new FakeProvider(runtime, "matter");
  runtime.registerProvider(matter);
  return { runtime, matter };
}
