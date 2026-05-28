import mbrBathroom from "./mbr-bathroom";
import office from "./office";
import type { EpaperDisplayDefinition } from "./types";

export const epaperDisplays = [
  office,
  mbrBathroom,
] satisfies EpaperDisplayDefinition[];

export function epaperDisplayById(id: string | undefined) {
  const normalized = normalizeDisplayId(id);
  return epaperDisplays.find((display) => normalizeDisplayId(display.id) === normalized || normalizeDisplayId(display.room) === normalized) ?? epaperDisplays[0];
}

function normalizeDisplayId(id: string | undefined) {
  return (id ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type { EpaperDisplayDefinition, EpaperStatDefinition } from "./types";
