import { describe, expect, it } from "vitest";
import { innovelli } from "../src/devices/innovelli";
import { defineRoomDevices, defineRoomRules } from "../src/runtime/dsl";
import { MatterLayerRuntime } from "../src/runtime/engine";
import type {
  CommandResult,
  DesiredCommand,
  ProviderAdapter,
} from "../src/runtime/types";

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Inovelli status LED rule", () => {
  it("uses 10% brightness for an off web override", async () => {
    const runtime = new MatterLayerRuntime({ dryRun: true });
    runtime.loadModules({
      devices: [
        defineRoomDevices("room", ({ room }) => {
          room.light = innovelli("room.light");
        }),
      ],
      rules: [
        defineRoomRules("room", ({ room, rule }) => {
          rule("light", () => room.light.auto(true));
        }),
      ],
    });
    await runtime.start();

    runtime.setWebOverride("room.light", { power: "off" }, { reason: "test" });
    await tick();

    expect(
      runtime.layers.surface("room.light.endpoint.6.statusLed"),
    ).toMatchObject({
      layer: "automation",
      output: {
        state: { power: "on", color: "purple", level: "10%" },
      },
    });
    runtime.stop();
  });

  it("applies the latest active layer after clearing a web override while LED commands are in flight", async () => {
    const runtime = new MatterLayerRuntime({ dryRun: true });
    const provider = new SlowLedProvider();
    runtime.registerProvider(provider);
    runtime.loadModules({
      devices: [
        defineRoomDevices("room", ({ room }) => {
          room.light = innovelli("room.light");
        }),
      ],
      rules: [
        defineRoomRules("room", ({ room, rule }) => {
          rule("light", () => room.light.auto(true));
        }),
      ],
    });
    await runtime.start();

    runtime.setWebOverride("room.light", { power: "off" }, { reason: "test" });
    await tick();
    runtime.clearLayer("room.light", "webOverride");
    await tick();

    while (provider.pendingLedCommands > 0) {
      provider.resolveNextLedCommand();
      await tick();
    }

    expect(provider.ledCommands.at(-1)).toMatchObject({
      state: { power: "on", color: "green", level: "50%" },
    });
    expect(
      runtime.layers.surface("room.light.endpoint.6.statusLed"),
    ).toMatchObject({
      layer: "automation",
      output: {
        state: { power: "on", color: "green", level: "50%" },
      },
    });
    runtime.stop();
  });
});

class SlowLedProvider implements ProviderAdapter {
  readonly name = "matter" as const;
  readonly ledCommands: DesiredCommand[] = [];
  private readonly resolvers: Array<() => void> = [];

  get pendingLedCommands() {
    return this.resolvers.length;
  }

  apply(command: DesiredCommand): Promise<CommandResult> {
    if (command.target !== "room.light.endpoint.6.statusLed") {
      return Promise.resolve(resultFor(command));
    }
    this.ledCommands.push(command);
    return new Promise((resolve) => {
      this.resolvers.push(() => resolve(resultFor(command)));
    });
  }

  resolveNextLedCommand() {
    this.resolvers.shift()?.();
  }
}

function resultFor(command: DesiredCommand): CommandResult {
  return {
    command,
    provider: "matter",
    dryRun: true,
    ok: true,
    appliedAt: Date.now(),
  };
}
