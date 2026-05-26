import { contact, light, matterDevice } from "matter-layer/devices";

export function myggbett(key: string) {
  return contact(key, {
    vendor: "IKEA of Sweden",
    product: "MYGGBETT door/window sensor",
    battery: {
      path: "1/47/12",
      encoding: "matter-battery-percent",
    },
    open: {
      path: "1/69/0",
      when: false,
    },
  });
}

export function kajplats(key: string) {
  return light(key, {
    vendor: "IKEA of Sweden",
    product: "KAJPLATS E26 CWS globe 1100lm",
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
  });
}

export function alpstuga(key: string) {
  return matterDevice(key, {
    vendor: "IKEA of Sweden",
    product: "ALPSTUGA air quality sensor",
    metrics: [
      { property: "temperature", label: "Temp", path: "1/1026/0", encoding: "matter-temperature", unit: "°" },
      { property: "co2", label: "CO2", path: "1/1037/0", unit: "ppm" },
    ],
  });
}
