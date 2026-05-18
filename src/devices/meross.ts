import { matterDevice } from "matter-layer/devices";

export function ms605Presence(key: string) {
  return matterDevice(key, {
    vendor: "Meross",
    product: "Smart Presence Sensor",
    presence: {
      path: "2/1030/0",
      when: true,
    },
    lux: {
      path: "1/1024/0",
      encoding: "matter-illuminance",
    },
    status: {
      path: "2/1030/0",
      when: true,
      values: {
        true: { label: "active", tone: "active" },
        false: { label: "clear", tone: "idle" },
      },
    },
    battery: {
      path: "1/47/12",
      encoding: "matter-battery-percent",
    },
  });
}
