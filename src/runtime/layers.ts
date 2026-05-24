import type { DesiredCommand, LayerName, LayerOutput, TargetId } from "./types";

export const layerPriority: Record<LayerName, number> = {
  safety: 1000,
  override: 800,
  webOverride: 700,
  scene: 600,
  automation: 400,
  default: 0,
};

export class LayerStore {
  private outputs = new Map<TargetId, Map<LayerName, LayerOutput>>();
  private writtenAt = new Map<string, number>();
  private lastDesired = new Map<TargetId, string>();

  write(target: TargetId, layer: LayerName, output: LayerOutput | null) {
    let targetLayers = this.outputs.get(target);
    if (!targetLayers) {
      targetLayers = new Map();
      this.outputs.set(target, targetLayers);
    }
    if (!output || output.state === null) {
      targetLayers.delete(layer);
      this.writtenAt.delete(layerKey(target, layer));
    } else {
      const previous = targetLayers.get(layer);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(output)) {
        this.writtenAt.set(layerKey(target, layer), Date.now());
      }
      targetLayers.set(layer, output);
    }
  }

  layer(target: TargetId, layer: LayerName) {
    return this.outputs.get(target)?.get(layer);
  }

  clear(target: TargetId, layer: LayerName) {
    this.outputs.get(target)?.delete(layer);
    this.writtenAt.delete(layerKey(target, layer));
  }

  snapshot() {
    return [...this.outputs.entries()].map(([target, layers]) => ({
      target,
      layers: [...layers.entries()].map(([layer, output]) => ({ layer, output, since: this.writtenAt.get(layerKey(target, layer)) })),
      surfaced: this.surface(target),
    }));
  }

  surface(target: TargetId) {
    const layers = this.outputs.get(target);
    if (!layers) {
      return null;
    }
    const now = Date.now();
    let best: { layer: LayerName; output: LayerOutput; since?: number } | null = null;
    for (const [layer, output] of layers) {
      if (output.expiresAt && output.expiresAt <= now) {
        layers.delete(layer);
        this.writtenAt.delete(layerKey(target, layer));
        continue;
      }
      if (!best || layerPriority[layer] > layerPriority[best.layer]) {
        best = { layer, output, since: this.writtenAt.get(layerKey(target, layer)) };
      }
    }
    return best;
  }

  expire(target: TargetId, now = Date.now()) {
    const layers = this.outputs.get(target);
    if (!layers) {
      return [];
    }
    const expired: LayerName[] = [];
    for (const [layer, output] of layers) {
      if (output.expiresAt && output.expiresAt <= now) {
        layers.delete(layer);
        this.writtenAt.delete(layerKey(target, layer));
        expired.push(layer);
      }
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
}

function layerKey(target: TargetId, layer: LayerName) {
  return `${target}:${layer}`;
}
