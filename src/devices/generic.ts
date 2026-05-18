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

export function matterSwitch(key: string) {
  return switchDevice(key, {
    power: {
      path: "1/6/0",
      commands: {
        on: { endpoint: 1, cluster: 6, command: "On" },
        off: { endpoint: 1, cluster: 6, command: "Off" },
      },
    },
  });
}
