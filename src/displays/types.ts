export type EpaperStatDefinition = {
  label: string;
  source?: string;
  signal?: string;
  unit?: string;
  format?: "integer" | "day-night";
  minUpdateMs?: number;
};

export type EpaperDisplayDefinition = {
  id: string;
  room: string;
  title?: string;
  stats?: EpaperStatDefinition[];
};
