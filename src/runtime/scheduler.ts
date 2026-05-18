import type { SourceUpdate } from "./types";

type SchedulerRuntime = {
  updateSource(update: SourceUpdate): void;
  scheduleAt(at: number, reason: string): void;
};

const schedulerState = globalThis as typeof globalThis & {
  __matterLayerSchedulerRuntime?: SchedulerRuntime | null;
};

export function setSchedulerRuntime(next: SchedulerRuntime | null) {
  schedulerState.__matterLayerSchedulerRuntime = next;
}

export function scheduleAt(at: number, reason: string) {
  schedulerState.__matterLayerSchedulerRuntime?.scheduleAt(at, reason);
}

export function emitSynthetic(source: string, value: unknown) {
  schedulerState.__matterLayerSchedulerRuntime?.updateSource({
    source,
    value,
    provider: "synthetic",
    observedAt: Date.now(),
  });
}
