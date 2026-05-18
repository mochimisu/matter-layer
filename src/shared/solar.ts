import { poll, state } from "matter-layer/rules";
import { minute } from "./time";

export const solarAngle = poll("solar.angle", minute, () =>
  state.solarAngle(),
);

export function solarDark() {
  return solarAngle.read().altitude < -4;
}
