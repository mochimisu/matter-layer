import type { SourceId } from "./types";

type TrackingFrame = {
  deps: Set<SourceId>;
  causes: Set<SourceId>;
  callIndex: number;
  scope?: string;
};

const trackingState = globalThis as typeof globalThis & {
  __matterLayerTrackingStack?: TrackingFrame[];
};

function stack() {
  trackingState.__matterLayerTrackingStack ??= [];
  return trackingState.__matterLayerTrackingStack;
}

export function track<T>(fn: () => T, scope?: string): { value: T; deps: Set<SourceId>; causes: Set<SourceId> } {
  const frame: TrackingFrame = { deps: new Set(), causes: new Set(), callIndex: 0, scope };
  stack().push(frame);
  try {
    return { value: fn(), deps: frame.deps, causes: frame.causes };
  } finally {
    stack().pop();
  }
}

export function recordRead(source: SourceId) {
  const frame = stack().at(-1);
  if (frame) {
    frame.deps.add(source);
  }
}

export function recordCause(source: SourceId) {
  const frame = stack().at(-1);
  if (frame) {
    frame.causes.add(source);
  }
}

export function currentReads() {
  return new Set(stack().at(-1)?.deps ?? []);
}

export function isTracking() {
  return stack().length > 0;
}

export function nextCallId(prefix: string) {
  const frame = stack().at(-1);
  if (!frame) {
    return `${prefix}.outside`;
  }
  frame.callIndex += 1;
  return frame.scope ? `${prefix}.${frame.scope}.${frame.callIndex}` : `${prefix}.${frame.callIndex}`;
}
