import mbrBathroom from "./mbr-bathroom";
import office from "./office";
import type { EpaperDisplayDefinition } from "./types";

export const epaperDisplays = [
  office,
  mbrBathroom,
] satisfies EpaperDisplayDefinition[];

export function epaperDisplayById(id: string | undefined) {
  return epaperDisplays.find((display) => display.id === id) ?? epaperDisplays[0];
}

export type { EpaperDisplayDefinition, EpaperStatDefinition } from "./types";
