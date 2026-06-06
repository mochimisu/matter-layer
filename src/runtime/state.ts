import type { LayerOutput } from "./types";
import { readClock, readClockUntracked } from "./builtins";
import { Signal, signal } from "./signals";
import { nextCallId, recordRead } from "./tracking";
import { scheduleAt } from "./scheduler";

type PulseState = {
  initialized?: boolean;
  previous?: unknown;
  lastTriggeredAt?: number;
  duration?: number;
};

type DelayState<T> = {
  pending?: T;
  clearAt?: number;
};

type HoldState = {
  wasActive?: boolean;
  clearAt?: number;
};

const runtimeState = globalThis as typeof globalThis & {
  __matterLayerPulses?: Map<string, PulseState>;
  __matterLayerTruth?: Map<string, { becameTrueAt?: number; wasTrueSince?: number }>;
  __matterLayerDelays?: Map<string, DelayState<unknown>>;
  __matterLayerHolds?: Map<string, HoldState>;
  __matterLayerLatches?: Map<string, boolean>;
  __matterLayerThrottles?: Map<string, { bucket: number; emitted: unknown; latest: unknown }>;
};

const pulses = runtimeState.__matterLayerPulses ?? (runtimeState.__matterLayerPulses = new Map());
const truth = runtimeState.__matterLayerTruth ?? (runtimeState.__matterLayerTruth = new Map());
const delays = runtimeState.__matterLayerDelays ?? (runtimeState.__matterLayerDelays = new Map());
const holds = runtimeState.__matterLayerHolds ?? (runtimeState.__matterLayerHolds = new Map());
const latches = runtimeState.__matterLayerLatches ?? (runtimeState.__matterLayerLatches = new Map());
const throttles = runtimeState.__matterLayerThrottles ?? (runtimeState.__matterLayerThrottles = new Map());

export const state = {
  expiring<T extends Record<string, unknown>>(
    value: T,
    meta: Omit<LayerOutput<T>, "state" | "expiresAt">,
    ttl: string,
  ): LayerOutput<T> {
    return {
      ...meta,
      state: value,
      expiresAt: Date.now() + parseDuration(ttl),
    };
  },

  optimistic<T>(value: T, _options: { ttl?: string } = {}) {
    return {
      value,
      set(next: T) {
        this.value = next;
      },
    };
  },

  timeBetween(start: string, end: string) {
    const now = new Date(readClock());
    const current = now.getHours() * 60 + now.getMinutes();
    const s = parseTime(start);
    const e = parseTime(end);
    if (s === e) return true;
    if (s < e) return current >= s && current < e;
    return current >= s || current < e;
  },

  wasTrueFor(value: boolean, duration: string) {
    const key = nextCallId("wasTrueFor");
    recordRead(key);
    const entry = truth.get(key) ?? {};
    const now = readClockUntracked();
    if (value) {
      entry.wasTrueSince ??= now;
      entry.becameTrueAt = now;
      truth.set(key, entry);
      const thresholdAt = entry.wasTrueSince + parseDuration(duration);
      if (now < thresholdAt) {
        scheduleAt(thresholdAt, key);
        return false;
      }
      return true;
    }
    if (entry.wasTrueSince !== undefined || entry.becameTrueAt !== undefined) {
      truth.delete(key);
    }
    return false;
  },

  holdTrue(key: string, value: boolean, delay: string) {
    const source = `holdTrue.${key}`;
    recordRead(source);
    const now = readClockUntracked();
    const entry = holds.get(source) ?? {};
    if (value) {
      holds.set(source, { wasActive: true });
      return true;
    }
    if (!entry.wasActive) {
      return false;
    }
    entry.clearAt ??= now + parseDuration(delay);
    if (now < entry.clearAt) {
      holds.set(source, entry);
      scheduleAt(entry.clearAt, source);
      return true;
    }
    holds.delete(source);
    return false;
  },

  latch(key: string, set: boolean, reset: boolean) {
    if (reset) {
      latches.set(key, false);
      return false;
    }
    if (set) {
      latches.set(key, true);
      return true;
    }
    return latches.get(key) ?? false;
  },

  delayClear<T extends Record<string, unknown>>(key: string, delay: string, value: T) {
    const now = readClock();
    const duration = parseDuration(delay);
    let entry = delays.get(key) as DelayState<T> | undefined;
    if (!entry || JSON.stringify(entry.pending) !== JSON.stringify(value)) {
      entry = { pending: value, clearAt: now + duration };
      delays.set(key, entry);
      scheduleAt(entry.clearAt!, key);
    }
    if (entry.clearAt && now >= entry.clearAt) {
      return value;
    }
    return null;
  },

  cancelDelay(key: string) {
    delays.delete(key);
  },

  derived<T>(_key: string, compute: () => T) {
    return compute();
  },

  within(value: boolean, _duration: string) {
    return value;
  },

  solarAngle() {
    return solarAngle(readClock());
  },

  pulse<T>(value: T, options: { activeWhen?: T; for: string }) {
    const key = nextCallId("pulse");
    recordRead(key);
    const entry = pulses.get(key) ?? {};
    const now = readClockUntracked();
    const activeWhen = "activeWhen" in options ? options.activeWhen : true;

    if (!entry.initialized) {
      entry.initialized = true;
      entry.previous = value;
      pulses.set(key, entry);
      return false;
    }

    const risingEdge =
      entry.previous !== undefined && Object.is(value, activeWhen) && !Object.is(entry.previous, activeWhen);
    entry.previous = value;

    if (risingEdge) {
      entry.lastTriggeredAt = now;
      entry.duration = parseDuration(options.for);
      scheduleAt(now + entry.duration, key);
    }

    pulses.set(key, entry);
    const duration = entry.duration ?? parseDuration(options.for);
    if (entry.lastTriggeredAt && now - entry.lastTriggeredAt < duration) {
      scheduleAt(entry.lastTriggeredAt + duration, key);
      return true;
    }
    return false;
  },

  throttle<T>(value: T | Signal<T>, options: { window: string; mode: "latest" }) {
    const key = nextCallId("throttle");
    return signal(() => {
      const current = value instanceof Signal ? value.read() : value;
      const now = readClock();
      const bucket = Math.floor(now / parseDuration(options.window));
      const entry = throttles.get(key);
      if (!entry || entry.bucket !== bucket) {
        throttles.set(key, { bucket, emitted: current, latest: current });
        return current;
      }
      if (options.mode === "latest") {
        entry.latest = current;
      }
      return entry.emitted as T;
    });
  },
};

export function pulseSnapshot() {
  return [...pulses.entries()]
    .filter(([, pulse]) => pulse.lastTriggeredAt && pulse.duration)
    .map(([source, pulse]) => ({
      source,
      lastTriggeredAt: pulse.lastTriggeredAt!,
      duration: pulse.duration!,
    }));
}

export function parseDuration(input: string) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${input}`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return value;
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60_000;
  return value * 3_600_000;
}

function parseTime(input: string) {
  const [hour, minute = "0"] = input.split(":");
  return Number(hour) * 60 + Number(minute);
}

function solarAngle(now: number) {
  const date = new Date(now);
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86_400_000);
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  const latitude = Number(process.env.MATTER_LAYER_LATITUDE ?? 45.5152);
  const declination = 23.44 * Math.sin(((360 / 365) * (dayOfYear - 81) * Math.PI) / 180);
  const hourAngle = (minuteOfDay / 4 - 180) * (Math.PI / 180);
  const lat = (latitude * Math.PI) / 180;
  const dec = (declination * Math.PI) / 180;
  const altitude =
    (Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle)) * 180) /
    Math.PI;
  return { altitude };
}
