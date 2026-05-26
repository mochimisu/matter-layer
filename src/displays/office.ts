import type { EpaperDisplayDefinition } from "./types";

export default {
  id: "office",
  room: "office",
  title: "Office",
  stats: [
    { label: "Temp", source: "office.airQuality.temperature", unit: "°", format: "integer", minUpdateMs: 5 * 60 * 1000 },
    { label: "CO2", source: "office.airQuality.co2", unit: "ppm", format: "integer", minUpdateMs: 5 * 60 * 1000 },
  ],
} satisfies EpaperDisplayDefinition;
