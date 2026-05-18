import { eventAction, remote } from "matter-layer/devices";
import { state } from "matter-layer/rules";
import type { CoverGroup, Remote } from "matter-layer/rules";

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
    battery: {
      path: "0/47/12",
      encoding: "matter-battery-percent",
    },
  });
}

export function bilresaBlinds(remote: Remote, covers: CoverGroup) {
  covers.state.motion ??= state.optimistic("idle", { ttl: "90s" });
  const outputs = covers.covers.map((cover) => cover.key);
  eventAction(`${remote.key}.open-blinds`, `${remote.key}.button.1.initialPress`, outputs);
  eventAction(`${remote.key}.close-blinds`, `${remote.key}.button.2.initialPress`, outputs);

  remote.onInitialPress(1, () => {
    if (covers.state.motion.value === "up") {
      covers.state.motion.set("idle");
      return covers.stop();
    }
    covers.state.motion.set("up");
    return covers.open();
  });

  remote.onInitialPress(2, () => {
    if (covers.state.motion.value === "down") {
      covers.state.motion.set("idle");
      return covers.stop();
    }
    covers.state.motion.set("down");
    return covers.close();
  });
}
