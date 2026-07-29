import { eventAction, remote, rule } from "matter-layer/devices";
import { state } from "matter-layer/rules";
import type { CoverGroup, Remote } from "matter-layer/rules";

type BlindMotion = "idle" | "up" | "down";

const directRemoteMinDelta = 1;
const remoteRepeatWindowMs = 2000;
const selfCommandWindowMs = 8000;
const manualReason = "Manual blind input";

export function bilresa(key: string): Remote {
  return remote(key, {
    vendor: "IKEA of Sweden",
    product: "BILRESA dual button",
    buttons: {
      1: { endpoint: 1, cluster: 59 },
      2: { endpoint: 2, cluster: 59 },
    },
    events: {
      initialPress: "InitialPress",
    },
    remoteKeepalive: true,
    battery: {
      path: "0/47/12",
      encoding: "matter-battery-percent",
    },
  });
}

export function bilresaBlinds(remote: Remote, covers: CoverGroup) {
  const intents = blindIntents(covers);
  const outputs = covers.covers.map((cover) => cover.key);
  eventAction(`${remote.key}.open-blinds`, `${remote.key}.button.1.initialPress`, outputs);
  eventAction(`${remote.key}.close-blinds`, `${remote.key}.button.2.initialPress`, outputs);
  rule(`${remote.key}.persist-manual-blind-input`, () => intents.persistManualOverrides());

  remote.onInitialPress(1, () => {
    intents.remoteOpen();
  });

  remote.onInitialPress(2, () => {
    intents.remoteClose();
  });
}

function blindIntents(covers: CoverGroup) {
  if (covers.state.blindIntents) {
    return covers.state.blindIntents as ReturnType<typeof createBlindIntents>;
  }
  const intents = createBlindIntents(covers);
  covers.state.blindIntents = intents;
  return intents;
}

function createBlindIntents(covers: CoverGroup) {
  covers.state.motion ??= state.optimistic<BlindMotion>("idle", { ttl: "90s" });
  const lastPositions = new Map<string, number>();
  let selfCommandUntil = 0;
  let lastRemoteMotionAt = 0;

  const markSelfCommand = () => {
    selfCommandUntil = Date.now() + selfCommandWindowMs;
  };

  const clearMatchingManual = (value: Record<string, unknown>) => {
    if (!covers.covers.every((cover) => manualOverrideMatches(cover.layer.override?.read(), value))) {
      return false;
    }
    covers.state.motion.set("idle");
    for (const cover of covers.covers) {
      cover.layer.override?.clear();
    }
    return true;
  };

  const writeManual = (value: Record<string, unknown>) => {
    if (clearMatchingManual(value)) {
      return;
    }
    for (const cover of covers.covers) {
      cover.forceApplyNext();
      cover.layer.override = {
        state: value,
        layer: "override",
        reason: manualReason,
        writer: "manual",
      };
    }
  };

  const open = () => {
    covers.state.motion.set("up");
    lastRemoteMotionAt = Date.now();
    markSelfCommand();
    writeManual({ position: "open" });
  };

  const close = () => {
    covers.state.motion.set("down");
    lastRemoteMotionAt = Date.now();
    markSelfCommand();
    writeManual({ position: "closed" });
  };

  const stop = () => {
    covers.state.motion.set("idle");
    markSelfCommand();
    writeManual({ motion: "stop" });
  };

  for (const cover of covers.covers) {
    cover.onPositionChange((value) => {
      const position = numericPosition(value);
      if (position === undefined) {
        return;
      }
      const previous = lastPositions.get(cover.key);
      lastPositions.set(cover.key, position);
      if (previous === undefined || Date.now() < selfCommandUntil) {
        return;
      }
      const delta = position - previous;
      if (Math.abs(delta) < directRemoteMinDelta) {
        return;
      }
      if (delta < 0 && covers.state.motion.value !== "up") {
        open();
      }
      if (delta > 0 && covers.state.motion.value !== "down") {
        close();
      }
    });
    cover.onActiveLayerChange((active) => {
      const isAutomationCommand = active?.layer === "automation";
      const isWebCommand = active?.layer === "override" && active.writer === "web";
      if (!isAutomationCommand && !isWebCommand) {
        return;
      }
      const motion = motionFromState(active.state);
      if (!motion) {
        return;
      }
      covers.state.motion.set(motion);
      markSelfCommand();
    });
  }

  return {
    persistManualOverrides() {
      for (const cover of covers.covers) {
        const current = cover.layer.override?.read();
        if (current?.writer !== "manual" || current.expiresAt === undefined) {
          continue;
        }
        cover.layer.override = {
          ...current,
          expiresAt: undefined,
        };
      }
    },
    remoteOpen() {
      if (clearMatchingManual({ position: "open" })) {
        return;
      }
      if (covers.state.motion.value === "up") {
        if (Date.now() - lastRemoteMotionAt < remoteRepeatWindowMs) {
          open();
        } else {
          stop();
        }
        return;
      }
      open();
    },
    remoteClose() {
      if (clearMatchingManual({ position: "closed" })) {
        return;
      }
      if (covers.state.motion.value === "down") {
        if (Date.now() - lastRemoteMotionAt < remoteRepeatWindowMs) {
          close();
        } else {
          stop();
        }
        return;
      }
      close();
    },
  };
}

function motionFromState(state: unknown): BlindMotion | undefined {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return undefined;
  }
  const record = state as Record<string, unknown>;
  if (record.motion === "stop") {
    return "idle";
  }
  if (record.position === "open") {
    return "up";
  }
  if (record.position === "closed") {
    return "down";
  }
  return undefined;
}

function manualOverrideMatches(output: unknown, value: Record<string, unknown>) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const layerOutput = output as { state?: unknown; writer?: unknown };
  return layerOutput.writer === "manual" && stateMatches(layerOutput.state, value);
}

function stateMatches(state: unknown, value: Record<string, unknown>) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return false;
  }
  const record = state as Record<string, unknown>;
  const keys = Object.keys(value);
  return keys.every((key) => record[key] === value[key]);
}

function numericPosition(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
