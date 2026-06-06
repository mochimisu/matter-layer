import { light, switchDevice } from "matter-layer/devices";
import type { LightOptions } from "matter-layer/devices";

export function matterLight(key: string, options: LightOptions = {}) {
  return light(key, {
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
    color: {
      cluster: 768,
      endpoint: 1,
    },
    ...options,
  });
}

export function matterSwitch(key: string, options: { endpoint?: number } & Record<string, unknown> = {}) {
  const endpoint = options.endpoint ?? 1;
  const device = switchDevice(key, {
    status: {
      property: "power",
      path: `${endpoint}/6/0`,
      values: {
        true: { label: "on", tone: "on" },
        false: { label: "off", tone: "off" },
      },
    },
    power: {
      path: `${endpoint}/6/0`,
      commands: {
        on: { endpoint, cluster: 6, command: "On" },
        off: { endpoint, cluster: 6, command: "Off" },
      },
    },
    ...options,
  });
  device.set({ power: "off" }, { layer: "default", reason: "Switch idle" });
  return device;
}
