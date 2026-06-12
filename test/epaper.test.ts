import { describe, expect, it } from "vitest";
import { renderRoomEpaperPanelSvg } from "../src/epaper";

describe("e-paper renderer", () => {
  it("shows concrete transitive source leaves instead of internal scheduler deps", () => {
    const snapshot = {
      sources: [
        { source: "office.door.open", key: "office.door", property: "open", value: true, since: 1 },
      ],
      signals: [
        {
          id: "office.presence",
          value: true,
          deps: ["office.door.open", "scheduler.office.presence.1"],
          initialized: true,
          lastRunAt: 1,
        },
      ],
      targets: [
        {
          target: "office.light",
          key: "office.light",
          provider: "matter",
          capabilities: { power: true },
        },
      ],
      rules: [
        {
          name: "office.light",
          enabled: true,
          deps: ["office.presence"],
          outputs: ["office.light"],
          lastRunAt: 1,
        },
      ],
      layers: [
        {
          target: "office.light",
          layers: [
            {
              layer: "automation",
              output: { state: { power: "on" }, reason: "office.light", writer: "office.light" },
              items: [
                { key: "office.light", output: { state: { power: "on" }, reason: "office.light", writer: "office.light" } },
              ],
            },
          ],
          surfaced: { layer: "automation", output: { state: { power: "on" }, reason: "office.light" } },
        },
      ],
      commands: [],
      matterLog: [],
      events: [],
      eventActions: [],
      pulses: [],
      providers: [
        { name: "matter", status: { enabled: false, connected: false, resolved: [] } },
      ],
    };

    const svg = renderRoomEpaperPanelSvg(snapshot as never, { room: "office", now: 1 });

    expect(svg).toContain(">door<");
    expect(svg).not.toContain("scheduler");
  });

  it("dashes event-action wires when the event has no current layer opinion", () => {
    const snapshot = {
      sources: [],
      signals: [],
      targets: [
        {
          target: "office.blinds",
          key: "office.blinds",
          provider: "matter",
          capabilities: { position: true },
        },
      ],
      rules: [],
      layers: [
        {
          target: "office.blinds",
          layers: [
            {
              layer: "default",
              output: { state: { position: "closed" }, reason: "Cover idle" },
            },
          ],
          surfaced: { layer: "default", output: { state: { position: "closed" }, reason: "Cover idle" } },
        },
      ],
      commands: [],
      matterLog: [],
      events: ["office.blindsRemote.button.1.initialPress"],
      eventActions: [
        {
          name: "office.blindsRemote.open-blinds",
          event: "office.blindsRemote.button.1.initialPress",
          outputs: ["office.blinds"],
          lastRunAt: 1,
        },
      ],
      pulses: [],
      providers: [
        { name: "matter", status: { enabled: false, connected: false, resolved: [] } },
      ],
    };

    const svg = renderRoomEpaperPanelSvg(snapshot as never, { room: "office", now: 1 });

    expect(svg).toContain("stroke=\"#999999\"");
    expect(svg).toContain("stroke-dasharray=");

    const grayscaleSvg = renderRoomEpaperPanelSvg(snapshot as never, { room: "office", now: 1, palette: "grayscale" });

    expect(grayscaleSvg).toContain("stroke=\"#999999\"");
    expect(grayscaleSvg).not.toContain("stroke-dasharray=");
  });

  it("only makes the active source path solid for an active automation opinion", () => {
    const snapshot = {
      sources: [
        { source: "office.near.presence", key: "office.near", property: "presence", value: true, since: 1 },
        { source: "office.far.presence", key: "office.far", property: "presence", value: false, since: 1 },
      ],
      signals: [],
      targets: [
        {
          target: "office.light",
          key: "office.light",
          provider: "matter",
          capabilities: { power: true },
        },
      ],
      rules: [
        {
          name: "office.light",
          enabled: true,
          deps: ["office.near.presence", "office.far.presence"],
          outputs: ["office.light"],
          lastRunAt: 1,
        },
      ],
      layers: [
        {
          target: "office.light",
          layers: [
            {
              layer: "automation",
              output: { state: { power: "on" }, reason: "office.light", writer: "office.light" },
              items: [
                { key: "office.light", output: { state: { power: "on" }, reason: "office.light", writer: "office.light" } },
              ],
            },
          ],
          surfaced: { layer: "automation", output: { state: { power: "on" }, reason: "office.light" } },
        },
      ],
      commands: [],
      matterLog: [],
      events: [],
      eventActions: [],
      pulses: [],
      providers: [
        { name: "matter", status: { enabled: false, connected: false, resolved: [] } },
      ],
    };

    const svg = renderRoomEpaperPanelSvg(snapshot as never, { room: "office", title: "Room", now: 1 });

    expect(svg).toContain(">near<");
    expect(svg).toContain(">far<");
    expect(svg.match(/stroke="#999999"/g) ?? []).toHaveLength(1);
    expect(svg.match(/stroke-dasharray=/g) ?? []).toHaveLength(1);
    expect(svg.indexOf("stroke=\"#999999\"")).toBeLessThan(svg.lastIndexOf("stroke=\"#000\" stroke-opacity=\"1\""));
  });

  it("keeps a transitive pulse source dashed unless the pulse is active", () => {
    const snapshot = {
      sources: [
        { source: "office.door.open", key: "office.door", property: "open", value: true, since: 1 },
      ],
      signals: [
        {
          id: "office.presence",
          value: true,
          deps: ["office.door.open", "pulse.office.presence.1"],
          initialized: true,
          lastRunAt: 1,
        },
      ],
      targets: [
        {
          target: "office.light",
          key: "office.light",
          provider: "matter",
          capabilities: { power: true },
        },
      ],
      rules: [
        {
          name: "office.light",
          enabled: true,
          deps: ["office.presence"],
          outputs: ["office.light"],
          lastRunAt: 1,
        },
      ],
      layers: [
        {
          target: "office.light",
          layers: [
            {
              layer: "automation",
              output: { state: { power: "on" }, reason: "office.light", writer: "office.light" },
              items: [
                { key: "office.light", output: { state: { power: "on" }, reason: "office.light", writer: "office.light" } },
              ],
            },
          ],
          surfaced: { layer: "automation", output: { state: { power: "on" }, reason: "office.light" } },
        },
      ],
      commands: [],
      matterLog: [],
      events: [],
      eventActions: [],
      pulses: [
        { source: "pulse.office.presence.1", lastTriggeredAt: 1, duration: 1000 },
      ],
      providers: [
        { name: "matter", status: { enabled: false, connected: false, resolved: [] } },
      ],
    };

    const svg = renderRoomEpaperPanelSvg(snapshot as never, { room: "office", now: 60_000 });

    expect(svg).toContain(">door<");
    expect(svg).not.toContain("pulse");
    expect(svg.match(/stroke="#999999"/g) ?? []).toHaveLength(1);
    expect(svg.match(/stroke-dasharray=/g) ?? []).toHaveLength(1);

    const activeSvg = renderRoomEpaperPanelSvg({
      ...snapshot,
      pulses: [
        { source: "pulse.office.presence.1", lastTriggeredAt: 59_000, duration: 5_000 },
      ],
    } as never, { room: "office", now: 60_000 });

    expect(activeSvg.match(/stroke="#999999"/g) ?? []).toHaveLength(0);
    expect(activeSvg.match(/stroke-dasharray=/g) ?? []).toHaveLength(0);
  });

  it("dashes active input wires when the rule wrote a null output", () => {
    const snapshot = {
      sources: [
        { source: "office.presence.presence", key: "office.presence", property: "presence", value: true, since: 1 },
      ],
      signals: [],
      targets: [
        {
          target: "office.light",
          key: "office.light",
          provider: "matter",
          capabilities: { power: true },
        },
      ],
      rules: [
        {
          name: "office.light",
          enabled: true,
          deps: ["office.presence.presence"],
          outputs: ["office.light"],
          outputWrites: [{ target: "office.light", hasOutput: false }],
          lastRunAt: 1,
        },
      ],
      layers: [],
      commands: [],
      matterLog: [],
      events: [],
      eventActions: [],
      pulses: [],
      providers: [
        { name: "matter", status: { enabled: false, connected: false, resolved: [] } },
      ],
    };

    const svg = renderRoomEpaperPanelSvg(snapshot as never, { room: "office", now: 1 });

    expect(svg).toContain(">presence<");
    expect(svg).toContain(">light<");
    expect(svg.match(/stroke="#999999"/g) ?? []).toHaveLength(1);
    expect(svg.match(/stroke-dasharray=/g) ?? []).toHaveLength(1);
  });

  it("draws a solid edge for a residual output caused by a now-clear input", () => {
    const snapshot = {
      sources: [
        { source: "office.presence.presence", key: "office.presence", property: "presence", value: false, since: 1 },
      ],
      signals: [],
      targets: [
        {
          target: "office.fan",
          key: "office.fan",
          provider: "matter",
          capabilities: { power: true },
        },
      ],
      rules: [
        {
          name: "office.fan",
          enabled: true,
          deps: ["office.presence.presence"],
          causes: ["office.presence.presence"],
          outputs: ["office.fan"],
          outputWrites: [{ target: "office.fan", hasOutput: true }],
          lastRunAt: 1,
        },
      ],
      layers: [
        {
          target: "office.fan",
          layers: [
            {
              layer: "automation",
              output: { state: { power: "on" }, reason: "office.fan", writer: "office.fan" },
              items: [
                { key: "office.fan", output: { state: { power: "on" }, reason: "office.fan", writer: "office.fan" } },
              ],
            },
          ],
          surfaced: { layer: "automation", output: { state: { power: "on" }, reason: "office.fan" } },
        },
      ],
      commands: [],
      matterLog: [],
      events: [],
      eventActions: [],
      pulses: [],
      providers: [
        { name: "matter", status: { enabled: false, connected: false, resolved: [] } },
      ],
    };

    const svg = renderRoomEpaperPanelSvg(snapshot as never, { room: "office", title: "Room", now: 1 });

    expect(svg).toContain(">presence<");
    expect(svg).not.toContain("stroke=\"#999999\"");
    expect(svg).not.toContain("stroke-dasharray=");
  });
});
