import { throttle, time } from "matter-layer/rules";

export const minute = throttle(time.tick, {
  window: "1m",
  mode: "latest",
});
