import type { EpaperDisplayDefinition } from "./types";

export default {
  id: "mbrBathroom",
  room: "mbrBathroom",
  title: "MBR Bathroom",
  hiddenTargets: ["mbrBathroom.environment"],
  stats: [
    { label: "Temp", source: "mbrBathroom.mainPresence.temperature", unit: "°", format: "integer" },
    { label: "Humidity", signal: "mbrBathroom.humidity", unit: "%", format: "integer" },
    { label: "Mode", signal: "mbrBathroom.daytime", format: "day-night" },
  ],
} satisfies EpaperDisplayDefinition;
