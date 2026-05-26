import { eventAction, remote } from "matter-layer/devices";
import { state } from "matter-layer/rules";
import type { CoverGroup, Remote } from "matter-layer/rules";

type BlindMotion = "idle" | "up" | "down";

const directRemoteMinDelta = 1;
const selfCommandWindowMs = 8000;
const manualOverrideTtl = "30m";
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

  const markSelfCommand = () => {
    selfCommandUntil = Date.now() + selfCommandWindowMs;
  };

  const writeManual = (value: Record<string, unknown>) => {
    for (const cover of covers.covers) {
      cover.layer.override = state.expiring(
        value,
        { layer: "override", reason: manualReason, writer: "manual" },
        manualOverrideTtl,
      );
    }
  };

  const open = () => {
    covers.state.motion.set("up");
    markSelfCommand();
    writeManual({ position: "open" });
  };

  const close = () => {
    covers.state.motion.set("down");
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
  }

  return {
    remoteOpen() {
      if (covers.state.motion.value === "up") {
        stop();
        return;
      }
      open();
    },
    remoteClose() {
      if (covers.state.motion.value === "down") {
        stop();
        return;
      }
      close();
    },
  };
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
