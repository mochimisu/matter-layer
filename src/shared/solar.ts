import { poll } from "../runtime/dsl";
import { state } from "../runtime/state";
import { minute } from "./time";

export const solarAngle = poll("solar.angle", minute, () =>
  state.solarAngle(),
);

export function solarDark() {
  return solarAngle.read().altitude < -4;
}
