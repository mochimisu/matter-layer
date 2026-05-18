import { recordRead, track } from "./tracking";
import type { SignalRegistration } from "./types";

const signalState = globalThis as typeof globalThis & {
  __matterLayerNextSignalId?: number;
};

export class Signal<T = unknown> {
  id: string;
  readonly registration: SignalRegistration<T>;
  private dependents = new Set<() => void>();
  readonly __matterLayerSignal = true;

  static [Symbol.hasInstance](value: unknown) {
    return Boolean(value && typeof value === "object" && (value as { __matterLayerSignal?: unknown }).__matterLayerSignal === true);
  }

  constructor(compute: () => T, id?: string) {
    signalState.__matterLayerNextSignalId = (signalState.__matterLayerNextSignalId ?? 0) + 1;
    this.id = id ?? `signal.${signalState.__matterLayerNextSignalId}`;
    this.registration = {
      id: this.id,
      compute,
      value: undefined,
      deps: new Set(),
      initialized: false,
    };
  }

  rename(id: string) {
    this.id = id;
    this.registration.id = id;
  }

  read(): T {
    recordRead(this.id);
    if (!this.registration.initialized) {
      this.evaluate();
    }
    return this.registration.value as T;
  }

  peek(): T | undefined {
    return this.registration.value;
  }

  evaluate(): boolean {
    const previous = this.registration.value;
    const result = track(this.registration.compute, this.id);
    this.registration.value = result.value;
    this.registration.deps = result.deps;
    this.registration.lastRunAt = Date.now();
    const changed = !this.registration.initialized || !Object.is(previous, result.value);
    this.registration.initialized = true;
    if (changed) {
      for (const dependent of this.dependents) {
        dependent();
      }
    }
    return changed;
  }

  onChange(fn: () => void) {
    this.dependents.add(fn);
  }
}

export function signal<T>(compute: () => T) {
  return new Signal(compute);
}
