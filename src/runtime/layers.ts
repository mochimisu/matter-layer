import type { DesiredCommand, LayerName, LayerOutput, TargetId } from "./types";

export const layerPriority: Record<LayerName, number> = {
  safety: 1000,
  override: 800,
  webOverride: 700,
  scene: 600,
  automation: 400,
  default: 0,
};

const layerOrder = (Object.keys(layerPriority) as LayerName[]).sort((left, right) => layerPriority[right] - layerPriority[left]);
export const defaultLayerItem = "__layer";
const overrideInputItem = "input";

export class LayerStore {
  private outputs = new Map<TargetId, Map<LayerName, Map<string, LayerOutput>>>();
  private writtenAt = new Map<string, number>();
  private lastDesired = new Map<TargetId, string>();

  write(target: TargetId, layer: LayerName, output: LayerOutput | null, itemKey?: string) {
    let targetLayers = this.outputs.get(target);
    if (!targetLayers) {
      targetLayers = new Map();
      this.outputs.set(target, targetLayers);
    }
    const key = itemKey ?? layerItemKey(layer, output);
    if (!output) {
      if (itemKey) {
        targetLayers.get(layer)?.delete(key);
        this.writtenAt.delete(layerKey(target, layer, key));
        if (targetLayers.get(layer)?.size === 0) targetLayers.delete(layer);
      } else {
        this.clear(target, layer);
      }
      return;
    }
    let bucket = targetLayers.get(layer);
    if (!bucket) {
      bucket = new Map();
      targetLayers.set(layer, bucket);
    }
    if (output.state === null) {
      bucket.delete(key);
      this.writtenAt.delete(layerKey(target, layer, key));
      if (bucket.size === 0) targetLayers.delete(layer);
      return;
    }
    const previous = bucket.get(key);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(output)) {
      this.writtenAt.set(layerKey(target, layer, key), Date.now());
      bucket.delete(key);
    }
    bucket.set(key, output);
  }

  layer(target: TargetId, layer: LayerName, itemKey?: string) {
    if (itemKey) {
      return this.outputs.get(target)?.get(layer)?.get(itemKey);
    }
    return this.bucketSurface(target, layer)?.output;
  }

  items(target: TargetId, layer: LayerName) {
    return [...(this.outputs.get(target)?.get(layer)?.entries() ?? [])].map(([key, output]) => ({ key, output }));
  }

  clear(target: TargetId, layer: LayerName, itemKey?: string) {
    const targetLayers = this.outputs.get(target);
    if (!targetLayers) return;
    if (itemKey) {
      const bucket = targetLayers.get(layer);
      bucket?.delete(itemKey);
      this.writtenAt.delete(layerKey(target, layer, itemKey));
      if (bucket?.size === 0) targetLayers.delete(layer);
      return;
    }
    for (const key of targetLayers.get(layer)?.keys() ?? []) {
      this.writtenAt.delete(layerKey(target, layer, key));
    }
    targetLayers.delete(layer);
  }

  snapshot() {
    return [...this.outputs.entries()].map(([target, layers]) => ({
      target,
      layers: layerOrder.flatMap((layer) => {
        const bucket = layers.get(layer);
        if (!bucket) return [];
        const surfaced = this.bucketSurface(target, layer);
        if (!surfaced) return [];
        return [{
          layer,
          output: surfaced.output,
          since: surfaced.since,
          items: [...bucket.entries()].map(([key, output]) => ({
            key,
            output,
            since: this.writtenAt.get(layerKey(target, layer, key)),
          })),
        }];
      }),
      surfaced: this.surface(target),
    }));
  }

  surface(target: TargetId) {
    const layers = this.outputs.get(target);
    if (!layers) {
      return null;
    }
    let combinedState: unknown;
    let highest: { layer: LayerName; output: LayerOutput; since?: number } | null = null;
    for (const layer of [...layerOrder].reverse()) {
      const bucket = layers.get(layer);
      if (!bucket) continue;
      const surfaced = this.bucketSurface(target, layer);
      if (!surfaced) continue;
      combinedState = mergeState(combinedState, surfaced.output.state);
      highest = surfaced;
    }
    return highest ? { ...highest, output: { ...highest.output, state: combinedState as Record<string, unknown> | null } } : null;
  }

  expire(target: TargetId, now = Date.now()) {
    const layers = this.outputs.get(target);
    if (!layers) {
      return [];
    }
    const expired: LayerName[] = [];
    for (const [layer, bucket] of layers) {
      let layerExpired = false;
      for (const [key, output] of bucket) {
        if (output.expiresAt && output.expiresAt <= now) {
          bucket.delete(key);
          this.writtenAt.delete(layerKey(target, layer, key));
          layerExpired = true;
        }
      }
      if (bucket.size === 0) layers.delete(layer);
      if (layerExpired) expired.push(layer);
    }
    return expired;
  }

  desiredCommand(target: TargetId): DesiredCommand | null {
    const surfaced = this.surface(target);
    if (!surfaced) {
      return null;
    }
    return {
      target,
      state: surfaced.output.state,
      providerPreference: "matter-first",
      reason: surfaced.output.reason,
    };
  }

  shouldApply(command: DesiredCommand) {
    const fingerprint = JSON.stringify(command);
    if (this.lastDesired.get(command.target) === fingerprint) {
      return false;
    }
    this.lastDesired.set(command.target, fingerprint);
    return true;
  }

  forgetDesired(target: TargetId) {
    this.lastDesired.delete(target);
  }

  private bucketSurface(target: TargetId, layer: LayerName) {
    const bucket = this.outputs.get(target)?.get(layer);
    if (!bucket) return null;
    let combinedState: unknown;
    let last: { key: string; output: LayerOutput; since?: number } | null = null;
    for (const [key, output] of bucket) {
      combinedState = mergeState(combinedState, output.state);
      last = { key, output, since: this.writtenAt.get(layerKey(target, layer, key)) };
    }
    return last
      ? {
          layer,
          output: { ...last.output, state: combinedState as Record<string, unknown> | null },
          since: last.since,
        }
      : null;
  }
}

function mergeState(base: unknown, next: unknown) {
  if (isRecord(base) && isRecord(next)) {
    const merged = { ...base, ...next };
    if (next.power === "off" || next.power === false) {
      delete merged.level;
    }
    return merged;
  }
  return next ?? base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function layerItemKey(layer: LayerName, output: LayerOutput | null) {
  if (layer === "override" && (output?.writer === "manual" || output?.writer === "web")) {
    return overrideInputItem;
  }
  return output?.writer ?? defaultLayerItem;
}

function layerKey(target: TargetId, layer: LayerName, itemKey: string) {
  return `${target}:${layer}:${itemKey}`;
}
