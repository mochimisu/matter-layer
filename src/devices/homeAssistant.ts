import { matterDevice } from "matter-layer/devices";

type HaMetricOptions = {
  label: string;
  unit?: string;
  entityId?: string;
  uniqueId?: string;
};

export function haEnvironmentSensor(
  key: string,
  options: {
    humidity?: HaMetricOptions;
    temperature?: HaMetricOptions;
  },
) {
  const metrics = [
    options.temperature
      ? {
          property: "temperature",
          label: options.temperature.label,
          unit: options.temperature.unit ?? "°",
          provider: "ha" as const,
          path: haSelector(options.temperature),
          encoding: "ha-number",
        }
      : undefined,
    options.humidity
      ? {
          property: "humidity",
          label: options.humidity.label,
          unit: options.humidity.unit ?? "%",
          provider: "ha" as const,
          path: haSelector(options.humidity),
          encoding: "ha-number",
        }
      : undefined,
  ].filter((metric): metric is NonNullable<typeof metric> => Boolean(metric));

  const device = matterDevice(key, {
    provider: "ha",
    vendor: "Home Assistant",
    product: "Environment Sensor",
    metrics,
  });
  for (const metric of metrics) {
    device.addSource<number>(metric.property, {
      provider: "ha",
      path: metric.path,
      encoding: metric.encoding,
    });
  }
  return device as typeof device & { temperature: number; humidity: number };
}

function haSelector(options: HaMetricOptions) {
  if (options.uniqueId) return `unique_id:${options.uniqueId}`;
  if (options.entityId) return options.entityId;
  throw new Error("HA metric requires uniqueId or entityId");
}
