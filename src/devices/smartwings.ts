import { cover, coverGroup } from "matter-layer/devices";
import type { CoverDevice } from "../runtime/devices";

type SmartWingsOptions = {
  openPosition?: number | string;
};

export function smartwings(key: string, options: SmartWingsOptions = {}) {
  return cover(key, {
    vendor: "SmartWings",
    product: "SmartWings Window Covering",
    position: {
      path: "1/258/14",
    },
    commands: {
      open: openCommand(options.openPosition),
      close: { endpoint: 1, cluster: 258, command: "DownOrClose" },
      stop: { endpoint: 1, cluster: 258, command: "StopMotion" },
    },
  });
}

export function smartwingsGroup(keys: Array<string | CoverDevice>) {
  return coverGroup(keys, {
    member: smartwings,
  });
}

function openCommand(openPosition: number | string | undefined) {
  if (openPosition === undefined) {
    return { endpoint: 1, cluster: 258, command: "UpOrOpen" };
  }
  return {
    endpoint: 1,
    cluster: 258,
    command: "GoToLiftPercentage",
    payload: {
      liftPercent100thsValue: percent100ths(openPosition),
    },
  };
}

function percent100ths(value: number | string) {
  if (typeof value === "string" && value.endsWith("%")) {
    return Math.round(Number(value.slice(0, -1)) * 100);
  }
  return Math.round(Number(value) * 100);
}
