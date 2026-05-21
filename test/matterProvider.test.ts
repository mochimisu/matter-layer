import { describe, expect, it } from "vitest";
import { MatterProvider } from "../src/providers/matter/provider";

describe("MatterProvider command translation", () => {
  function providerWithTarget(target: string, capabilities: Record<string, unknown>) {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    internals.targets.set(target, { target, capabilities });
    internals.nodeByKey.set(target, 123);
    return internals;
  }

  it("includes required LevelControl fields for MoveToLevelWithOnOff", () => {
    const internals = providerWithTarget("room.light", {
        power: {
          commands: {
            on: { endpoint: 1, cluster: 6, command: "On" },
            off: { endpoint: 1, cluster: 6, command: "Off" },
          },
        },
        level: {
          command: { endpoint: 1, cluster: 8, command: "MoveToLevelWithOnOff" },
        },
    });

    const messages = internals.translateCommand({
      target: "room.light",
      state: { power: "on", level: "10%" },
      providerPreference: "matter-first",
    });

    expect(messages).toEqual([
      {
        command: "device_command",
        args: {
          node_id: 123,
          endpoint_id: 1,
          cluster_id: 6,
          command_name: "On",
          payload: {},
        },
      },
      {
        command: "device_command",
        args: {
          node_id: 123,
          endpoint_id: 1,
          cluster_id: 8,
          command_name: "MoveToLevelWithOnOff",
          payload: {
            level: 25,
            transitionTime: 0,
            optionsMask: 0,
            optionsOverride: 0,
          },
        },
      },
    ]);
  });

  it("includes required ColorControl fields for MoveToHueAndSaturation", () => {
    const internals = providerWithTarget("room.light.endpoint.6.statusLed", {
      color: {
        endpoint: 6,
        cluster: 768,
      },
    });

    const messages = internals.translateCommand({
      target: "room.light.endpoint.6.statusLed",
      state: { color: "green" },
      providerPreference: "matter-first",
    });

    expect(messages).toEqual([
      {
        command: "device_command",
        args: {
          node_id: 123,
          endpoint_id: 6,
          cluster_id: 768,
          command_name: "MoveToHueAndSaturation",
          payload: {
            hue: 85,
            saturation: 254,
            transitionTime: 0,
            optionsMask: 0,
            optionsOverride: 0,
          },
        },
      },
    ]);
  });

  it("maps closed cover position to the close command", () => {
    const internals = providerWithTarget("room.blinds", {
      commands: {
        open: { endpoint: 1, cluster: 258, command: "UpOrOpen" },
        close: { endpoint: 1, cluster: 258, command: "DownOrClose" },
        stop: { endpoint: 1, cluster: 258, command: "StopMotion" },
      },
    });

    const messages = internals.translateCommand({
      target: "room.blinds",
      state: { position: "closed" },
      providerPreference: "matter-first",
    });

    expect(messages).toEqual([
      {
        command: "device_command",
        args: {
          node_id: 123,
          endpoint_id: 1,
          cluster_id: 258,
          command_name: "DownOrClose",
          payload: {},
        },
      },
    ]);
  });

  it("supports cover open commands with preset payloads", () => {
    const internals = providerWithTarget("room.blinds", {
      commands: {
        open: {
          endpoint: 1,
          cluster: 258,
          command: "GoToLiftPercentage",
          payload: { liftPercent100thsValue: 5000 },
        },
      },
    });

    const messages = internals.translateCommand({
      target: "room.blinds",
      state: { position: "open" },
      providerPreference: "matter-first",
    });

    expect(messages).toEqual([
      {
        command: "device_command",
        args: {
          node_id: 123,
          endpoint_id: 1,
          cluster_id: 258,
          command_name: "GoToLiftPercentage",
          payload: { liftPercent100thsValue: 5000 },
        },
      },
    ]);
  });

  it("maps switch events through configured paddle endpoints", () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const events: string[] = [];
    internals.targets.set("room.light", {
      target: "room.light",
      capabilities: {
        switch: {
          cluster: 59,
          upEndpoint: 3,
          downEndpoint: 4,
        },
      },
    });
    internals.nodeByKey.set("room.light", 123);
    internals.runtime = {
      dispatchEvent(event: string) {
        events.push(event);
      },
    };

    internals.ingestDeviceEvent({ node_id: 123, endpoint_id: 3, cluster_id: 59, event_id: 1 });
    internals.ingestDeviceEvent({ node_id: 123, endpoint_id: 4, cluster_id: 59, event_id: 1 });

    expect(events).toEqual([
      "room.light.paddle.up.singlePress",
      "room.light.paddle.down.singlePress",
    ]);
  });

  it("resolves endpoint targets through their parent device", () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    internals.targets.set("room.light.endpoint.6.statusLed", {
      target: "room.light.endpoint.6.statusLed",
      capabilities: {
        power: {
          commands: {
            on: { endpoint: 6, cluster: 6, command: "On" },
            off: { endpoint: 6, cluster: 6, command: "Off" },
          },
        },
      },
    });

    internals.ingestNodes([{ node_id: 123, attributes: { "0/40/5": "Room Light" } }]);

    expect(internals.nodeByKey.get("room.light.endpoint.6.statusLed")).toBe(123);
    expect(internals.snapshot().unresolvedTargets).not.toContain("room.light.endpoint.6.statusLed");
  });

  it("exposes node availability in the provider snapshot", () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    internals.targets.set("room.light", {
      target: "room.light",
      capabilities: {},
    });

    internals.ingestNodes([{ node_id: 123, available: false, attributes: { "0/40/5": "Room Light" } }]);

    expect(internals.snapshot().resolved).toEqual([
      {
        key: "room.light",
        nodeId: 123,
        label: "Room Light",
        mac: undefined,
        available: false,
        offlineSince: expect.any(Number),
      },
    ]);

    internals.ingestNodes([{ node_id: 123, available: true, attributes: { "0/40/5": "Room Light" } }]);

    expect(internals.snapshot().resolved[0].available).toBe(true);
    expect(internals.snapshot().resolved[0].offlineSince).toBeUndefined();
  });
});
