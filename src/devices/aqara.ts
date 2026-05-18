import { matterDevice } from "matter-layer/devices";

export function fp300(key: string) {
  return matterDevice(key, {
    vendor: "Aqara",
    product: "Presence Multi-Sensor FP300",
    presence: {
      path: "1/1030/0",
      when: true,
    },
    lux: {
      path: "2/1024/0",
      encoding: "matter-illuminance",
    },
    status: {
      path: "1/1030/0",
      when: true,
      values: {
        true: { label: "active", tone: "active" },
        false: { label: "clear", tone: "idle" },
      },
    },
    battery: {
      path: "5/47/12",
      encoding: "matter-battery-percent",
    },
  });
}
