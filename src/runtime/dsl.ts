import { signal, Signal } from "./signals";
import { state } from "./state";
import { clockSource, minuteSource } from "./builtins";
import type { LayerOutput, RuleRegistration } from "./types";

export type RoomModule = {
  room: string;
  kind: "devices" | "rules";
  setup: (context: RoomDevicesContext | RoomRulesContext) => void;
};

export type Ruleset = {
  devices: RoomModule[];
  rules: RoomModule[];
};

export type RuleHandle = {
  readonly __matterLayerRule: true;
  readonly name: string;
  readonly run: () => void;
};

export type SceneHandle = {
  readonly __matterLayerScene: true;
  readonly name: string;
  readonly rules: readonly RuleHandle[];
};

export type RuleRegistrar = (name: string, run: () => void) => RuleHandle;
export type SceneRegistrar = (
  name: string,
  entries: RuleHandle | SceneHandle | Array<RuleHandle | SceneHandle>,
) => SceneHandle;
export type RoomDevicesContext<Room = any, Rooms = any> = {
  room: Room;
  rooms: Rooms;
  matter: Record<string, unknown>;
};
export type RoomRulesContext<Room = any, Rooms = any> = {
  room: Room;
  rooms: Rooms;
  rule: RuleRegistrar;
  scene: SceneRegistrar;
};

export function defineRoomDevices<Room = any, Rooms = any>(
  room: string,
  setup: (context: RoomDevicesContext<Room, Rooms>) => void,
): RoomModule {
  return { room, kind: "devices", setup: setup as RoomModule["setup"] };
}

export function defineRoomRules<Room = any, Rooms = any>(
  room: string,
  setup: (context: RoomRulesContext<Room, Rooms>) => void,
): RoomModule {
  return { room, kind: "rules", setup: setup as RoomModule["setup"] };
}

export function defineRules(ruleset: Ruleset) {
  return ruleset;
}

export function any(...values: unknown[]) {
  return values.map(readMaybeSignal).some(Boolean);
}

export function pulse<T>(value: T, options: { activeWhen?: T; for: string }) {
  return state.pulse(value, options);
}

export const time = {
  tick: signal(() => clockSource.read() ?? Date.now()),
  minute: minuteSource,
  minuteBetween(start: string, end: string) {
    return timeBetween(minuteSource.read(), start, end);
  },
};

export function throttle<T>(value: T | Signal<T>, options: { window: string; mode: "latest" }) {
  return state.throttle(value, options);
}

export function poll<T>(_key: string, trigger: unknown, compute: () => T) {
  return signal(() => {
    readMaybeSignal(trigger);
    return compute();
  });
}

export function createRoomProxy(roomState: Record<string, unknown>) {
  return new Proxy(roomState, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value instanceof Signal) {
        return value.read();
      }
      return value;
    },
  });
}

export function createDefinitionRoom(roomState: Record<string, unknown>) {
  return new Proxy(roomState, {
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (value instanceof Signal && typeof prop === "string") {
        value.rename(prop);
      }
      return Reflect.set(target, prop, value, receiver);
    },
  });
}

export function createRuleRegistration(name: string, run: () => void): RuleRegistration {
  return {
    name,
    run,
    enabled: true,
    deps: new Set(),
    causes: new Set(),
    outputs: new Set(),
    outputWrites: new Map(),
  };
}

function timeBetween(now: number | undefined, start: string, end: string) {
  const date = new Date(now ?? Date.now());
  const current = date.getHours() * 60 + date.getMinutes();
  const startMinute = parseTime(start);
  const endMinute = parseTime(end);
  if (startMinute === endMinute) return true;
  if (startMinute < endMinute) return current >= startMinute && current < endMinute;
  return current >= startMinute || current < endMinute;
}

function parseTime(input: string) {
  const [hour, minute = "0"] = input.split(":");
  return Number(hour) * 60 + Number(minute);
}

export function isLayerOutput(value: unknown): value is LayerOutput {
  return Boolean(value && typeof value === "object" && "state" in value);
}

function readMaybeSignal(value: unknown) {
  if (value instanceof Signal) {
    return value.read();
  }
  return value;
}
