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

  it("uses XY ColorControl commands for XY-only lights", () => {
    const internals = providerWithTarget("mbr.blindsStatus", {
      color: {
        endpoint: 1,
        cluster: 768,
        mode: "xy",
      },
    });

    const messages = internals.translateCommand({
      target: "mbr.blindsStatus",
      state: { color: "purple" },
      providerPreference: "matter-first",
    });

    expect(messages).toEqual([
      {
        command: "device_command",
        args: {
          node_id: 123,
          endpoint_id: 1,
          cluster_id: 768,
          command_name: "MoveToColor",
          payload: {
            colorX: 21031,
            colorY: 10106,
            transitionTime: 0,
            optionsMask: 0,
            optionsOverride: 0,
          },
        },
      },
    ]);
  });

  it("supports per-device XY color calibration", () => {
    const internals = providerWithTarget("mbr.blindsStatus", {
      color: {
        endpoint: 1,
        cluster: 768,
        mode: "xy",
        colors: { purple: [14723, 21544] },
      },
    });

    const [message] = internals.translateCommand({
      target: "mbr.blindsStatus",
      state: { color: "purple" },
      providerPreference: "matter-first",
    });

    expect(message.args).toMatchObject({
      command_name: "MoveToColor",
      payload: { colorX: 14723, colorY: 21544 },
    });
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

  it("suppresses BILRESA multipress fallback after an initial press", () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const events: string[] = [];
    const logs: any[] = [];
    internals.targets.set("room.remote", {
      target: "room.remote",
      capabilities: {
        buttons: {
          1: { endpoint: 1, cluster: 59 },
        },
        events: {
          initialPress: "InitialPress",
        },
      },
    });
    internals.nodeByKey.set("room.remote", 123);
    internals.runtime = {
      dispatchEvent(event: string) {
        events.push(event);
      },
      logMatter(entry: any) {
        logs.push(entry);
      },
    };

    internals.ingestDeviceEvent({ node_id: 123, endpoint_id: 1, cluster_id: 59, event_id: 1 });
    internals.ingestDeviceEvent({ node_id: 123, endpoint_id: 1, cluster_id: 59, event_id: 6 });

    expect(events).toEqual(["room.remote.button.1.initialPress"]);
    expect(logs[0]).toMatchObject({
      direction: "received",
      kind: "event",
      subject: "room.remote",
      key: "room.remote",
      nodeId: 123,
      endpoint: 1,
      clusterId: 59,
      eventId: 1,
      event: "room.remote.button.1.initialPress",
    });
  });

  it("keeps BILRESA multipress fallback when initial press is absent", () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const events: string[] = [];
    internals.targets.set("room.remote", {
      target: "room.remote",
      capabilities: {
        buttons: {
          1: { endpoint: 1, cluster: 59 },
        },
      },
    });
    internals.nodeByKey.set("room.remote", 123);
    internals.runtime = {
      dispatchEvent(event: string) {
        events.push(event);
      },
    };

    internals.ingestDeviceEvent({ node_id: 123, endpoint_id: 1, cluster_id: 59, event_id: 6 });

    expect(events).toEqual(["room.remote.button.1.initialPress"]);
  });

  it("tracks node event activity separately from Matter availability", () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    internals.targets.set("room.remote", {
      target: "room.remote",
      capabilities: {
        buttons: {
          1: { endpoint: 1, cluster: 59 },
        },
      },
    });
    internals.nodeByKey.set("room.remote", 123);
    internals.availableByNode.set(123, false);
    internals.runtime = {
      dispatchEvent() {},
      notifyProviderChanged() {},
    };

    internals.ingestDeviceEvent({ node_id: 123, endpoint_id: 1, cluster_id: 59, event_id: 1 });

    const node = internals.snapshot().nodes.find((item: any) => item.nodeId === 123);
    expect(node).toMatchObject({
      nodeId: 123,
      available: false,
      lastHeardAt: expect.any(Number),
      lastEventAt: expect.any(Number),
    });
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
        offlineSince: undefined,
      },
    ]);

    internals.ingestNodes([{ node_id: 123, available: true, attributes: { "0/40/5": "Room Light" } }]);

    expect(internals.snapshot().resolved[0].available).toBe(true);
    expect(internals.snapshot().resolved[0].offlineSince).toBeUndefined();

    internals.ingestNodes([{ node_id: 123, available: false, attributes: { "0/40/5": "Room Light" } }]);

    expect(internals.snapshot().resolved[0].available).toBe(false);
    expect(internals.snapshot().resolved[0].offlineSince).toEqual(expect.any(Number));
  });

  it("summarizes Thread neighbor-table RSSI in the provider snapshot", () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    internals.targets.set("room.router", {
      target: "room.router",
      capabilities: {},
    });

    internals.ingestNodes([
      {
        node_id: 123,
        attributes: {
          "0/40/5": "Room Router",
          "0/53/7": [
            { "6": -82 },
            { "6": 201 },
            { "6": -54 },
          ],
        },
      },
    ]);

    expect(internals.snapshot().resolved[0]).toMatchObject({
      key: "room.router",
      nodeId: 123,
      rssi: -54,
    });
  });

  it("can ingest cached node snapshots without emitting source values", () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const updates: Array<{ source: string; value: unknown }> = [];
    internals.runtime = {
      updateSource(update: { source: string; value: unknown }) {
        updates.push({ source: update.source, value: update.value });
      },
      notifyProviderChanged() {},
    };
    internals.sources = [
      {
        source: "room.door.open",
        key: "room.door",
        property: "open",
        provider: "matter",
        path: "1/69/0",
        when: false,
      },
    ];

    internals.ingestNodes(
      [{ node_id: 123, available: true, attributes: { "0/40/5": "Room Door", "1/69/0": false } }],
      { emitSourceValues: false },
    );

    expect(internals.nodeByKey.get("room.door")).toBe(123);
    expect(internals.sourceByNodePath.get("123:1/69/0")).toEqual([internals.sources[0]]);
    expect(updates).toEqual([]);
  });

  it("can seed startup source values from cached node snapshots without marking them fresh", () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const updates: Array<{ source: string; value: unknown; markUpdated?: boolean }> = [];
    internals.runtime = {
      updateSource(update: { source: string; value: unknown; markUpdated?: boolean }) {
        updates.push({ source: update.source, value: update.value, markUpdated: update.markUpdated });
      },
      notifyProviderChanged() {},
    };
    internals.sources = [
      {
        source: "room.presence.presence",
        key: "room.presence",
        property: "presence",
        provider: "matter",
        path: "2/1030/0",
        when: true,
      },
    ];

    internals.ingestNodes(
      [{ node_id: 123, available: true, attributes: { "0/40/5": "Room Presence", "2/1030/0": true } }],
      { markSourcesUpdated: false },
    );

    expect(internals.nodeByKey.get("room.presence")).toBe(123);
    expect(updates).toEqual([
      { source: "room.presence.presence", value: true, markUpdated: false },
    ]);
  });

  it("syncs startup source values with explicit Matter attribute reads", async () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const updates: Array<{ source: string; value: unknown; markUpdated?: boolean }> = [];
    const sources = [
      {
        source: "room.light.power",
        key: "room.light",
        property: "power",
        provider: "matter",
        path: "1/6/0",
      },
      {
        source: "room.light.level",
        key: "room.light",
        property: "level",
        provider: "matter",
        path: "1/8/0",
      },
    ];
    const messages: Array<{ command: string; args: Record<string, unknown> }> = [];
    internals.runtime = {
      updateSource(update: { source: string; value: unknown; markUpdated?: boolean }) {
        updates.push({ source: update.source, value: update.value, markUpdated: update.markUpdated });
      },
      notifyProviderChanged() {},
    };
    internals.sources = sources;
    internals.send = async (message: { command: string; args: Record<string, unknown> }) => {
      messages.push(message);
      return {
        result: {
          [message.args.attribute_path as string]: message.args.attribute_path === "1/6/0" ? false : 87,
        },
      };
    };

    internals.ingestNodes(
      [{ node_id: 123, available: true, attributes: { "0/40/5": "Room Light", "1/6/0": true, "1/8/0": 254 } }],
      { emitSourceValues: false },
    );
    await internals.syncStartupSourceAttributes();

    expect(messages).toEqual([
      {
        command: "read_attribute",
        args: { node_id: 123, attribute_path: "1/6/0" },
      },
      {
        command: "read_attribute",
        args: { node_id: 123, attribute_path: "1/8/0" },
      },
    ]);
    expect(updates).toEqual([
      { source: "room.light.power", value: false, markUpdated: true },
      { source: "room.light.level", value: 87, markUpdated: true },
    ]);
  });

  it("refreshes bound source values during a target probe", async () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const updates: Array<{ source: string; value: unknown }> = [];
    internals.runtime = {
      updateSource(update: { source: string; value: unknown }) {
        updates.push({ source: update.source, value: update.value });
      },
      notifyProviderChanged() {},
    };
    internals.nodeByKey.set("room.light", 123);
    internals.sources = [
      {
        source: "room.light.power",
        key: "room.light",
        property: "power",
        provider: "matter",
        path: "1/6/0",
      },
    ];
    internals.sourceByNodePath.set("123:1/6/0", [internals.sources[0]]);
    internals.send = async (message: { args: { attribute_path: string } }) => ({
      result: { [message.args.attribute_path]: message.args.attribute_path === "1/6/0" ? true : "Room Light" },
    });

    const result = await provider.probeTarget("room.light");

    expect(result).toMatchObject({
      ok: true,
      nodeId: 123,
      reads: expect.arrayContaining([
        expect.objectContaining({ path: "1/6/0", ok: true, value: true }),
        expect.objectContaining({ path: "0/40/5", ok: true, value: "Room Light" }),
      ]),
    });
    expect(updates).toEqual([{ source: "room.light.power", value: true }]);
  });

  it("marks ping_node false results as failed and unavailable", async () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const logs: any[] = [];
    internals.runtime = {
      notifyProviderChanged() {},
      logMatter(entry: any) {
        logs.push(entry);
      },
    };
    internals.nodeByKey.set("room.remote", 123);
    internals.availableByNode.set(123, true);
    internals.send = async () => ({
      result: { "fd00::123": false },
    });

    const result = await provider.pingTarget("room.remote");

    expect(result).toMatchObject({
      ok: false,
      target: "room.remote",
      nodeId: 123,
      result: { "fd00::123": false },
      error: "Matter ping failed",
    });
    expect(internals.availableByNode.get(123)).toBe(false);
    expect(internals.offlineSinceByNode.get(123)).toEqual(expect.any(Number));
    expect(internals.lastProbeByTarget.get("room.remote")).toEqual(expect.any(Number));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      direction: "sent",
      kind: "ping",
      subject: "room.remote",
      key: "room.remote",
      nodeId: 123,
      ok: false,
      error: "Matter ping failed",
    });
  });

  it("keeps ping_node true results available", async () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    internals.runtime = {
      notifyProviderChanged() {},
    };
    internals.nodeByKey.set("room.remote", 123);
    internals.availableByNode.set(123, false);
    internals.offlineSinceByNode.set(123, Date.now() - 1000);
    internals.send = async () => ({
      result: { "fd00::123": true },
    });

    const result = await provider.pingTarget("room.remote");

    expect(result).toMatchObject({
      ok: true,
      target: "room.remote",
      nodeId: 123,
      result: { "fd00::123": true },
    });
    expect(internals.availableByNode.get(123)).toBe(true);
    expect(internals.offlineSinceByNode.get(123)).toBeUndefined();
  });

  it("probes stale Thread source values with attribute reads", async () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const source = {
      source: "room.light.power",
      key: "room.light",
      property: "power",
      provider: "matter",
      path: "1/6/0",
    };
    const updates: Array<{ source: string; value: unknown }> = [];
    internals.runtime = {
      updateSource(update: { source: string; value: unknown }) {
        updates.push({ source: update.source, value: update.value });
      },
      notifyProviderChanged() {},
    };
    internals.connected = true;
    internals.ws = { readyState: 1 };
    internals.targets.set("room.light", { target: "room.light", capabilities: {} });
    internals.sources = [source];
    internals.sourceRefs.set(source.source, { updated: () => Date.now() - 121_000 });
    internals.nodeByKey.set("room.light", 123);
    internals.availableByNode.set(123, true);
    internals.rssiByNode.set(123, -54);
    internals.sourceByNodePath.set("123:1/6/0", [source]);
    const messages: Array<{ command: string; args: Record<string, unknown> }> = [];
    internals.send = async (message: { command: string; args: Record<string, unknown> }) => {
      messages.push(message);
      return { result: { [message.args.attribute_path as string]: message.args.attribute_path === "1/6/0" ? true : "Room Light" } };
    };

    await internals.probeStaleTargets();

    expect(updates).toEqual([{ source: "room.light.power", value: true }]);
    expect(messages).toEqual([
      {
        command: "read_attribute",
        args: { node_id: 123, attribute_path: "1/6/0" },
      },
      {
        command: "read_attribute",
        args: { node_id: 123, attribute_path: "0/40/5" },
      },
    ]);
    expect(internals.availableByNode.get(123)).toBe(true);
    expect(internals.lastProbeByTarget.get("room.light")).toEqual(expect.any(Number));
  });

  it("skips stale probing for fresh source updates", async () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const source = {
      source: "room.light.power",
      key: "room.light",
      property: "power",
      provider: "matter",
      path: "1/6/0",
    };
    let readCount = 0;
    internals.runtime = {
      updateSource() {},
      notifyProviderChanged() {},
    };
    internals.connected = true;
    internals.ws = { readyState: 1 };
    internals.targets.set("room.light", { target: "room.light", capabilities: {} });
    internals.sources = [source];
    internals.sourceRefs.set(source.source, { updated: () => Date.now() });
    internals.nodeByKey.set("room.light", 123);
    internals.availableByNode.set(123, true);
    internals.rssiByNode.set(123, -54);
    internals.sourceByNodePath.set("123:1/6/0", [source]);
    internals.send = async () => {
      readCount += 1;
      return { result: {} };
    };

    await internals.probeStaleTargets();

    expect(readCount).toBe(0);
    expect(internals.lastProbeByTarget.get("room.light")).toBeUndefined();
  });

  it("probes unavailable Thread sources after the slower stale window", async () => {
    const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
    const internals = provider as any;
    const source = {
      source: "room.light.power",
      key: "room.light",
      property: "power",
      provider: "matter",
      path: "1/6/0",
    };
    const updates: Array<{ source: string; value: unknown }> = [];
    internals.runtime = {
      updateSource(update: { source: string; value: unknown }) {
        updates.push({ source: update.source, value: update.value });
      },
      notifyProviderChanged() {},
    };
    internals.connected = true;
    internals.ws = { readyState: 1 };
    internals.targets.set("room.light", { target: "room.light", capabilities: {} });
    internals.sources = [source];
    internals.sourceRefs.set(source.source, { updated: () => Date.now() - 301_000 });
    internals.nodeByKey.set("room.light", 123);
    internals.availableByNode.set(123, false);
    internals.rssiByNode.set(123, -54);
    internals.sourceByNodePath.set("123:1/6/0", [source]);
    internals.send = async (message: { args: { attribute_path: string } }) => ({
      result: { [message.args.attribute_path]: message.args.attribute_path === "1/6/0" ? true : "Room Light" },
    });

    await internals.probeStaleTargets();

    expect(updates).toEqual([{ source: "room.light.power", value: true }]);
    expect(internals.availableByNode.get(123)).toBe(true);
    expect(internals.lastProbeByTarget.get("room.light")).toEqual(expect.any(Number));
  });

  it("limits stale Thread source probes when configured", async () => {
    const previousMax = process.env.MATTER_STALE_PROBE_MAX_PER_PASS;
    process.env.MATTER_STALE_PROBE_MAX_PER_PASS = "1";
    try {
      const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
      const internals = provider as any;
      const sources = ["room.one.power", "room.two.power"].map((source) => ({
        source,
        key: source.replace(".power", ""),
        property: "power",
        provider: "matter",
        path: "1/6/0",
      }));
      const messages: Array<{ command: string; args: Record<string, unknown> }> = [];
      internals.runtime = {
        updateSource() {},
        notifyProviderChanged() {},
      };
      internals.connected = true;
      internals.ws = { readyState: 1 };
      internals.sources = sources;
      for (const source of sources) {
        internals.sourceRefs.set(source.source, { updated: () => Date.now() - 121_000 });
      }
      internals.nodeByKey.set("room.one", 1);
      internals.nodeByKey.set("room.two", 2);
      internals.availableByNode.set(1, true);
      internals.availableByNode.set(2, true);
      internals.rssiByNode.set(1, -54);
      internals.rssiByNode.set(2, -55);
      internals.sourceByNodePath.set("1:1/6/0", [sources[0]]);
      internals.sourceByNodePath.set("2:1/6/0", [sources[1]]);
      internals.send = async (message: { command: string; args: Record<string, unknown> }) => {
        messages.push(message);
        return { result: { [message.args.attribute_path as string]: true } };
      };

      await internals.probeStaleTargets();

      expect(messages.map((message) => message.args.node_id)).toEqual([1, 1]);
      expect(internals.lastProbeByTarget.get("room.one")).toEqual(expect.any(Number));
      expect(internals.lastProbeByTarget.get("room.two")).toBeUndefined();
    } finally {
      if (previousMax === undefined) {
        delete process.env.MATTER_STALE_PROBE_MAX_PER_PASS;
      } else {
        process.env.MATTER_STALE_PROBE_MAX_PER_PASS = previousMax;
      }
    }
  });

  it("does not stale-probe the same Matter node through multiple source aliases", async () => {
    const previousMax = process.env.MATTER_STALE_PROBE_MAX_PER_PASS;
    process.env.MATTER_STALE_PROBE_MAX_PER_PASS = "2";
    try {
      const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
      const internals = provider as any;
      const sources = [
        {
          source: "room.light.power",
          key: "room.light",
          property: "power",
          provider: "matter",
          path: "1/6/0",
        },
        {
          source: "room.light.endpoint.6.statusLed.power",
          key: "room.light.endpoint.6.statusLed",
          property: "power",
          provider: "matter",
          path: "6/6/0",
        },
      ];
      const messages: Array<{ command: string; args: Record<string, unknown> }> = [];
      internals.runtime = {
        updateSource() {},
        notifyProviderChanged() {},
      };
      internals.connected = true;
      internals.ws = { readyState: 1 };
      internals.targets.set("room.light", { target: "room.light", capabilities: {} });
      internals.targets.set("room.light.endpoint.6.statusLed", { target: "room.light.endpoint.6.statusLed", capabilities: {} });
      internals.sources = sources;
      for (const source of sources) {
        internals.sourceRefs.set(source.source, { updated: () => Date.now() - 121_000 });
      }
      internals.nodeByKey.set("room.light", 123);
      internals.nodeByKey.set("room.light.endpoint.6.statusLed", 123);
      internals.availableByNode.set(123, true);
      internals.rssiByNode.set(123, -54);
      internals.sourceByNodePath.set("123:1/6/0", [sources[0]]);
      internals.sourceByNodePath.set("123:6/6/0", [sources[1]]);
      internals.send = async (message: { command: string; args: Record<string, unknown> }) => {
        messages.push(message);
        return { result: { [message.args.attribute_path as string]: true } };
      };

      await internals.probeStaleTargets();

      expect(messages.map((message) => message.args)).toEqual([
        { node_id: 123, attribute_path: "1/6/0" },
        { node_id: 123, attribute_path: "6/6/0" },
        { node_id: 123, attribute_path: "0/40/5" },
      ]);
      expect(internals.lastProbeByTarget.get("room.light")).toEqual(expect.any(Number));
      expect(internals.lastProbeByTarget.get("room.light.endpoint.6.statusLed")).toBeUndefined();
    } finally {
      if (previousMax === undefined) {
        delete process.env.MATTER_STALE_PROBE_MAX_PER_PASS;
      } else {
        process.env.MATTER_STALE_PROBE_MAX_PER_PASS = previousMax;
      }
    }
  });

  it("keeps flagged remotes warm without pinging ordinary button targets", async () => {
    const previousMax = process.env.MATTER_REMOTE_KEEPALIVE_MAX_PER_PASS;
    const previousPerNode = process.env.MATTER_REMOTE_KEEPALIVE_PER_NODE_SEC;
    process.env.MATTER_REMOTE_KEEPALIVE_MAX_PER_PASS = "2";
    process.env.MATTER_REMOTE_KEEPALIVE_PER_NODE_SEC = "5";
    try {
      const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
      const internals = provider as any;
      const messages: Array<{ command: string; args: Record<string, unknown> }> = [];
      internals.runtime = {
        notifyProviderChanged() {},
        logMatter() {},
      };
      internals.connected = true;
      internals.ws = { readyState: 1 };
      internals.targets.set("room.remote", {
        target: "room.remote",
        capabilities: {
          buttons: {
            1: { endpoint: 1, cluster: 59 },
          },
          remoteKeepalive: true,
        },
      });
      internals.targets.set("room.otherRemote", {
        target: "room.otherRemote",
        capabilities: {
          buttons: {
            1: { endpoint: 1, cluster: 59 },
          },
        },
      });
      internals.nodeByKey.set("room.remote", 123);
      internals.nodeByKey.set("room.otherRemote", 456);
      internals.send = async (message: { command: string; args: Record<string, unknown> }) => {
        messages.push(message);
        return { result: { "fd00::node": true } };
      };

      await internals.pingRemoteTargetsOnce();

      expect(messages).toEqual([{ command: "ping_node", args: { node_id: 123 } }]);
      expect(internals.lastProbeByTarget.get("room.remote")).toEqual(expect.any(Number));
      expect(internals.lastProbeByTarget.get("room.otherRemote")).toBeUndefined();
    } finally {
      if (previousMax === undefined) {
        delete process.env.MATTER_REMOTE_KEEPALIVE_MAX_PER_PASS;
      } else {
        process.env.MATTER_REMOTE_KEEPALIVE_MAX_PER_PASS = previousMax;
      }
      if (previousPerNode === undefined) {
        delete process.env.MATTER_REMOTE_KEEPALIVE_PER_NODE_SEC;
      } else {
        process.env.MATTER_REMOTE_KEEPALIVE_PER_NODE_SEC = previousPerNode;
      }
    }
  });

  it("does not start the remote keepalive loop when disabled", () => {
    const provider = new MatterProvider({
      url: "ws://example.invalid",
      dryRun: false,
      remoteKeepaliveEnabled: false,
    });
    const internals = provider as any;

    internals.startRemoteKeepaliveLoop();

    expect(internals.remoteKeepaliveTimer).toBeUndefined();
  });

  it("does not start the stale probe loop when remote keepalive is disabled", () => {
    const provider = new MatterProvider({
      url: "ws://example.invalid",
      dryRun: false,
      remoteKeepaliveEnabled: false,
    });
    const internals = provider as any;

    internals.startStaleProbeLoop();

    expect(internals.staleProbeTimer).toBeUndefined();
  });

  it("toggles remote keepalive at runtime", () => {
    const provider = new MatterProvider({
      url: "ws://example.invalid",
      dryRun: false,
      remoteKeepaliveEnabled: false,
    });
    const internals = provider as any;
    let changed = 0;
    internals.runtime = {
      notifyProviderChanged() {
        changed += 1;
      },
    };

    provider.setRemoteKeepaliveEnabled(true);
    expect(provider.snapshot()).toMatchObject({ remoteKeepaliveEnabled: true });
    expect(internals.staleProbeTimer).toBeDefined();
    expect(internals.remoteKeepaliveTimer).toBeDefined();

    provider.setRemoteKeepaliveEnabled(false);
    expect(provider.snapshot()).toMatchObject({ remoteKeepaliveEnabled: false });
    expect(internals.staleProbeTimer).toBeUndefined();
    expect(internals.remoteKeepaliveTimer).toBeUndefined();
    expect(changed).toBe(2);
  });

  it("dedupes remote keepalive pings by Matter node", async () => {
    const previousMax = process.env.MATTER_REMOTE_KEEPALIVE_MAX_PER_PASS;
    const previousPerNode = process.env.MATTER_REMOTE_KEEPALIVE_PER_NODE_SEC;
    process.env.MATTER_REMOTE_KEEPALIVE_MAX_PER_PASS = "3";
    process.env.MATTER_REMOTE_KEEPALIVE_PER_NODE_SEC = "5";
    try {
      const provider = new MatterProvider({ url: "ws://example.invalid", dryRun: false });
      const internals = provider as any;
      const messages: Array<{ command: string; args: Record<string, unknown> }> = [];
      internals.runtime = {
        notifyProviderChanged() {},
        logMatter() {},
      };
      internals.connected = true;
      internals.ws = { readyState: 1 };
      for (const target of ["room.remote", "room.remote.alias"]) {
        internals.targets.set(target, {
          target,
          capabilities: {
            buttons: {
              1: { endpoint: 1, cluster: 59 },
            },
            remoteKeepalive: true,
          },
        });
        internals.nodeByKey.set(target, 123);
      }
      internals.send = async (message: { command: string; args: Record<string, unknown> }) => {
        messages.push(message);
        return { result: { "fd00::123": true } };
      };

      await internals.pingRemoteTargetsOnce();

      expect(messages).toEqual([{ command: "ping_node", args: { node_id: 123 } }]);
    } finally {
      if (previousMax === undefined) {
        delete process.env.MATTER_REMOTE_KEEPALIVE_MAX_PER_PASS;
      } else {
        process.env.MATTER_REMOTE_KEEPALIVE_MAX_PER_PASS = previousMax;
      }
      if (previousPerNode === undefined) {
        delete process.env.MATTER_REMOTE_KEEPALIVE_PER_NODE_SEC;
      } else {
        process.env.MATTER_REMOTE_KEEPALIVE_PER_NODE_SEC = previousPerNode;
      }
    }
  });
});
