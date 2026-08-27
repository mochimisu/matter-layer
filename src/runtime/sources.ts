import { recordRead } from "./tracking";
import type { ProviderName, SourceBinding, SourceId, SourceUpdate } from "./types";

export class SourceRef<T = unknown> {
  readonly source: SourceId;
  readonly binding: SourceBinding;
  private observedValue: T | undefined;
  private overrideValue?: { value: T; reason?: string; expiresAt?: number; since: number };
  private sinceAt: number | undefined;
  private updatedAt: number | undefined;

  constructor(binding: SourceBinding) {
    this.source = binding.source;
    this.binding = binding;
  }

  read(): T {
    recordRead(this.source);
    return this.peek() as T;
  }

  peek(): T | undefined {
    return this.overrideValue?.value ?? this.observedValue;
  }

  observed(): T | undefined {
    return this.observedValue;
  }

  override() {
    return this.overrideValue;
  }

  since(): number | undefined {
    return this.sinceAt;
  }

  updated(): number | undefined {
    return this.updatedAt;
  }

  update(value: T, observedAt = Date.now(), options: { markUpdated?: boolean } = {}): boolean {
    if (options.markUpdated !== false) {
      this.updatedAt = observedAt;
    }
    const previous = this.peek();
    if (Object.is(this.observedValue, value)) {
      return false;
    }
    this.observedValue = value;
    if (!this.overrideValue && !Object.is(previous, value)) {
      this.sinceAt = observedAt;
      return true;
    }
    return false;
  }

  setOverride(value: T, options: { reason?: string; expiresAt?: number; since?: number } = {}) {
    const previous = this.peek();
    const since = options.since ?? Date.now();
    this.overrideValue = { value, reason: options.reason, expiresAt: options.expiresAt, since };
    if (!Object.is(previous, value)) {
      this.sinceAt = since;
      return true;
    }
    return false;
  }

  clearOverride(at = Date.now()) {
    if (!this.overrideValue) return false;
    const previous = this.peek();
    this.overrideValue = undefined;
    if (!Object.is(previous, this.observedValue)) {
      this.sinceAt = at;
      return true;
    }
    return false;
  }
}

export function sourceId(key: string, property: string) {
  return `${key}.${property}`;
}

export function makeSource<T>(args: {
  key: string;
  property: string;
  provider?: ProviderName;
  path?: string;
  when?: unknown;
  encoding?: string;
}) {
  const source = sourceId(args.key, args.property);
  return new SourceRef<T>({
    source,
    key: args.key,
    property: args.property,
    provider: args.provider ?? "matter",
    path: args.path,
    when: args.when,
    encoding: args.encoding,
  });
}

export function normalizeValue(binding: SourceBinding, raw: unknown) {
  let value = raw;
  if (binding.encoding === "matter-illuminance" && typeof raw === "number") {
    value = raw <= 0 ? 0 : Math.pow(10, (raw - 1) / 10000);
  }
  if (binding.encoding === "matter-battery-percent" && typeof raw === "number") {
    value = raw > 100 ? raw / 2 : raw;
  }
  if (binding.encoding === "matter-battery-voltage" && typeof raw === "number") {
    value = raw / 10;
  }
  if (binding.encoding === "matter-percent" && typeof raw === "number") {
    value = raw > 100 ? raw / 100 : raw;
  }
  if (binding.encoding === "matter-humidity" && typeof raw === "number") {
    value = raw / 100;
  }
  if (binding.encoding === "matter-temperature" && typeof raw === "number") {
    value = raw / 100;
  }
  if ("when" in binding && binding.when !== undefined) {
    value =
      typeof binding.when === "boolean"
        ? Boolean(value) === binding.when
        : Object.is(value, binding.when);
  }
  return value;
}

export function makeUpdate(source: SourceId, value: unknown, provider: ProviderName): SourceUpdate {
  return {
    source,
    value,
    provider,
    observedAt: Date.now(),
  };
}
