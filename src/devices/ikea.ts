import { contact, light } from "matter-layer/devices";

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
