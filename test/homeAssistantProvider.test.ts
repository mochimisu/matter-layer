import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { haEnvironmentSensor } from "../src/devices/homeAssistant";
import { HomeAssistantProvider } from "../src/providers/homeAssistant/provider";
import { defineRoomDevices } from "../src/runtime/dsl";
import { MatterLayerRuntime } from "../src/runtime/engine";

const servers: WebSocketServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("HomeAssistantProvider", () => {
  it("resolves unique ids and subscribes to matching state changes", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    const port = (server.address() as { port: number }).port;

    server.on("connection", (client) => {
      client.send(JSON.stringify({ type: "auth_required" }));
      client.on("message", (buffer) => {
        const message = JSON.parse(String(buffer));
        if (message.type === "auth") {
          client.send(JSON.stringify({ type: "auth_ok" }));
          return;
        }
        if (message.type === "config/entity_registry/list") {
          client.send(JSON.stringify({
            id: message.id,
            type: "result",
            success: true,
            result: [
              {
                entity_id: "sensor.usl_environmental_humidity",
                unique_id: "8CEDE1B2EE0C_humidity_level",
              },
            ],
          }));
          return;
        }
        if (message.type === "get_states") {
          client.send(JSON.stringify({
            id: message.id,
            type: "result",
            success: true,
            result: [
              {
                entity_id: "sensor.usl_environmental_humidity",
                state: "67.0",
                last_changed: "2026-05-29T01:00:00.000Z",
              },
            ],
          }));
          return;
        }
        if (message.type === "subscribe_events") {
          client.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
          client.send(JSON.stringify({
            id: message.id,
            type: "event",
            event: {
              event_type: "state_changed",
              data: {
                entity_id: "sensor.usl_environmental_humidity",
                new_state: {
                  state: "68.5",
                  last_changed: "2026-05-29T01:01:00.000Z",
                },
              },
            },
          }));
        }
      });
    });

    const runtime = new MatterLayerRuntime({ dryRun: true });
    runtime.loadModules({
      devices: [
        defineRoomDevices("room", ({ room }) => {
          room.environment = haEnvironmentSensor("room.environment", {
            humidity: {
              label: "Humidity",
              uniqueId: "8CEDE1B2EE0C_humidity_level",
            },
          });
        }),
      ],
      rules: [],
    });
    runtime.registerProvider(new HomeAssistantProvider({
      url: `ws://127.0.0.1:${port}/api/websocket`,
      token: "test-token",
    }));

    await runtime.start();
    await tick();

    expect(runtime.sources.get("room.environment.humidity")?.peek()).toBe(68.5);
    expect(runtime.snapshot().providers.find((provider) => provider.name === "ha")?.status).toMatchObject({
      connected: true,
      authenticated: true,
      sourceCount: 1,
      entityCount: 1,
    });
    runtime.stop();
  });
});
