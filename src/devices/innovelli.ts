import { activeLayer, eventAction, light, rule } from "matter-layer/devices";
import type { Light, LightOptions } from "matter-layer/devices";
import { parseDuration } from "../runtime/state";
import type { LayerName } from "../runtime/types";

const ledColors: Partial<Record<LayerName, string>> = {
  automation: "green",
  webOverride: "purple",
  override: "purple",
};

export function innovelli(key: string, options: LightOptions = {}): Light {
  const onDefaults = { level: "100%", ...(options.on ?? {}) };
  const device = light(key, {
    vendor: "Inovelli",
    product: "VTM31-SN",
    power: {
      path: "1/6/0",
      commands: {
        on: { endpoint: 1, cluster: 6, command: "On" },
        off: { endpoint: 1, cluster: 6, command: "Off" },
      },
    },
    level: {
      path: "1/8/0",
      command: { endpoint: 1, cluster: 8, command: "MoveToLevelWithOnOff" },
    },
    switch: {
      cluster: 59,
      upEndpoint: 3,
      downEndpoint: 4,
    },
    vendorCluster: 305134641,
    ...options,
    on: onDefaults,
  });
  device.set({ power: "off" }, { layer: "default", reason: "Switch idle" });
  const led = device.endpoint(6).light("statusLed", {
    epaper: { excludeFromFlow: true },
  });
  led.set({ power: "on", color: "green", level: "2%" }, { layer: "default", reason: "Status LED idle" });
  const dimmerLayer = activeLayer(device.key);

  device.auto = (
    value: boolean | Record<string, unknown> | null | undefined,
  ) => {
    const write = () => {
      if (value === true) {
        device.set({ ...device.defaults }, { layer: "automation" });
      } else if (value) {
        device.set(value, { layer: "automation" });
      } else {
        device.set(null, { layer: "automation" });
      }
    };
    write();
    return write;
  };

  rule(`${key}.status-led`, () => {
    const active = dimmerLayer.read();
    if (!active || !ledColors[active.layer]) {
      led.set(null, { layer: "automation" });
      return;
    }
    led.set(ledStateFor(active), {
      layer: "automation",
      reason: active.reason,
    });
  });

  function manualOverride(value: string, ttl: string = "30m") {
    const current = device.layer.override?.read();
    if (current?.writer === "manual" && statePower(current.state) === value) {
      device.layer.override?.clear();
      return;
    }
    const expiresAt = Date.now() + parseDuration(ttl);
    device.layer.override = {
      state: { power: value },
      layer: "override",
      reason: `Paddle pressed until ${formatExpirationTime(expiresAt)}`,
      writer: "manual",
      expiresAt,
    };
  }

  device.paddle("up").onSinglePress(() => manualOverride("on"));
  device.paddle("down").onSinglePress(() => manualOverride("off"));
  eventAction(`${key}.override-on`, `${key}.paddle.up.singlePress`, [
    device.key,
    led.key,
  ]);
  eventAction(`${key}.override-off`, `${key}.paddle.down.singlePress`, [
    device.key,
    led.key,
  ]);

  return device;
}

function statePower(state: unknown) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return undefined;
  }
  return (state as Record<string, unknown>).power;
}

function ledStateFor(active: {
  layer: LayerName;
  state?: unknown;
  power?: unknown;
}) {
  const state = active.state && typeof active.state === "object" && !Array.isArray(active.state)
    ? active.state as Record<string, unknown>
    : undefined;
  const power = state?.power ?? active.power;
  return {
    power: "on",
    color: ledColors[active.layer],
    level: power === "off" || power === false ? "10%" : "50%",
  };
}

function formatExpirationTime(timestamp: number) {
  const date = new Date(timestamp);
  const hour = date.getHours();
  const minute = date.getMinutes().toString().padStart(2, "0");
  const displayHour = hour % 12 || 12;
  const meridiem = hour >= 12 ? "PM" : "AM";
  return `${displayHour}:${minute} ${meridiem}`;
}
