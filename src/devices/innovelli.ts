import { eventAction, light } from "matter-layer/devices";
import { state } from "matter-layer/rules";
import type { Light, LightOptions } from "matter-layer/devices";

export function innovelli(key: string, options: LightOptions = {}): Light {
  const device = light(key, {
    vendor: "Inovelli",
    product: "VTM31-SN",
    power: {
      path: "1/6/0",
      commands: {
        on: { endpoint: 1, cluster: 6, command: "On" },
        off: { endpoint: 1, cluster: 6, command: "Off" },
      },
    },
    level: {
      path: "1/8/0",
      command: { endpoint: 1, cluster: 8, command: "MoveToLevelWithOnOff" },
    },
    switch: {
      cluster: 59,
      upEndpoint: 3,
      downEndpoint: 4,
    },
    vendorCluster: 305134641,
    ...options,
  });
  const led = device.endpoint(6).light("statusLed");
  led.set(
    { power: "off" },
    { layer: "default", reason: "Status LED idle" },
  );

  function manualOverride(value: string, ttl: string = "30m") {
    if (device.layer.override) {
      device.layer.override.clear();
      led.layer.override.clear();
      return;
    }
    device.layer.override = state.expiring(
      { power: value },
      { layer: "override", reason: "Device Interaction" },
      ttl,
    );
    led.layer.override = state.expiring(
      { power: "on", color: "green", level: "100%" },
      { layer: "override", reason: "Device Interaction" },
      ttl,
    );
  }

  device.paddle("up").onSinglePress(() => manualOverride("on"));
  device.paddle("down").onSinglePress(() => manualOverride("off"));
  eventAction(`${key}.override-on`, `${key}.paddle.up.singlePress`, [device.key, led.key]);
  eventAction(`${key}.override-off`, `${key}.paddle.down.singlePress`, [device.key, led.key]);

  return device;
}
