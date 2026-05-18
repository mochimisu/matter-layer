import { SourceRef } from "./sources";

const builtinState = globalThis as typeof globalThis & {
  __matterLayerClockSource?: SourceRef<number>;
};

export const clockSource =
  builtinState.__matterLayerClockSource ??
  (builtinState.__matterLayerClockSource = new SourceRef<number>({
    source: "time.tick",
    key: "time",
    property: "tick",
    provider: "timer",
  }));

export function readClock() {
  return clockSource.read() ?? Date.now();
}

export function readClockUntracked() {
  return clockSource.peek() ?? Date.now();
}
