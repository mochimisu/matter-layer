import { signal, Signal } from "./signals";
import { state } from "./state";
import { clockSource } from "./builtins";
import type { LayerOutput, RuleRegistration } from "./types";

export type RoomModule = {
  room: string;
  kind: "devices" | "rules";
  setup: (context: any) => void;
};

export type Ruleset = {
  devices: RoomModule[];
  rules: RoomModule[];
};

let activeRuleRegistrar: ((name: string, run: () => void) => void) | null = null;

export function defineRoomDevices(room: string, setup: (context: any) => void): RoomModule {
  return { room, kind: "devices", setup };
}

export function defineRoomRules(room: string, setup: (context: any) => void): RoomModule {
  return { room, kind: "rules", setup };
}

export function defineRules(ruleset: Ruleset) {
  return ruleset;
}

export function setRuleRegistrar(registrar: ((name: string, run: () => void) => void) | null) {
  activeRuleRegistrar = registrar;
}

export function rule(name: string, run: (() => void) | (() => () => void)) {
  if (!activeRuleRegistrar) {
    throw new Error("rule(...) called outside defineRoomRules");
  }
  const maybeRun = run();
  activeRuleRegistrar(name, typeof maybeRun === "function" ? maybeRun : (run as () => void));
}

export function any(...values: unknown[]) {
  return values.map(readMaybeSignal).some(Boolean);
}

export function pulse<T>(value: T, options: { activeWhen?: T; for: string }) {
  return state.pulse(value, options);
}

export const time = {
  tick: signal(() => clockSource.read() ?? Date.now()),
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
    outputs: new Set(),
    outputWrites: new Map(),
  };
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
