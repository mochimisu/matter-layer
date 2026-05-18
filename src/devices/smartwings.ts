import { cover, coverGroup } from "matter-layer/devices";

export function smartwings(key: string) {
  return cover(key, {
    vendor: "SmartWings",
    product: "SmartWings Window Covering",
    position: {
      path: "1/258/14",
    },
    commands: {
      open: { endpoint: 1, cluster: 258, command: "UpOrOpen" },
      close: { endpoint: 1, cluster: 258, command: "DownOrClose" },
      stop: { endpoint: 1, cluster: 258, command: "StopMotion" },
    },
  });
}

export function smartwingsGroup(keys: string[]) {
  return coverGroup(keys, {
    member: smartwings,
  });
}
