# matter-layer

Always-on TypeScript automation layer for Matter and Home Assistant.

`matter-layer` is a small programmer-friendly TypeScript API for direct Matter
websocket events and commands. It ships as a reusable runtime plus NixOS module:
users provide their own device definitions, room rules, and Matter identity
bindings.

The runtime default is intentionally empty. Reusable device interpretation
factories live in [src/devices](src/devices); users keep their own room/device
rules in a private rules module.

## NixOS Flake Install

Add the flake input:

```nix
inputs.matter-layer.url = "github:YOUR_ORG/matter-layer";
```

Import the NixOS module and point it at your rules module:

```nix
{
  inputs,
  ...
}: {
  imports = [
    inputs.matter-layer.nixosModules.default
  ];

  services.matter-layer = {
    enable = true;
    openFirewall = true;
    port = 3000;
    matterWsUrl = "ws://127.0.0.1:5580/ws";
    rulesModule = ./matter-layer/rules.ts;
    bindings = {
      "room.light".label = "Room Light";
      "room.presence".label = "Room Presence";
    };
  };
}
```

The NixOS service runs one process that starts both the automation runtime and
the web/API server. The web UI is served from the same port after the package
builds it.

## User Rules

A user's rules module exports `defineRules({ devices, rules })` and can import
the built-in API:

```ts
import { defineRoomDevices, defineRoomRules, defineRules, signal } from "matter-layer/rules";
import { innovelli, ms605Presence } from "matter-layer/devices";

const roomDevices = defineRoomDevices("room", ({ room }) => {
  room.light = innovelli("room.light");
  room.occupancy = ms605Presence("room.presence");
  room.presence = signal(() => room.occupancy.presence);
});

const roomRules = defineRoomRules("room", ({ room, rule }) => {
  rule("light", () => room.light.auto(room.presence));
});

export default defineRules({
  devices: [roomDevices],
  rules: [roomRules],
});
```

Users can write their own device factories the same way the built-ins do:

```ts
import { light } from "matter-layer/devices";

export function myDimmer(key: string) {
  return light(key, {
    power: {
      path: "1/6/0",
      commands: {
        on: { endpoint: 1, cluster: 6, command: "On" },
        off: { endpoint: 1, cluster: 6, command: "Off" },
      },
    },
  });
}
```

## Development

Use direnv/Nix for system dependencies:

```sh
direnv allow
npm install
```

Useful commands:

```sh
npm run typecheck
npm test
npm run web:build
nix flake check --no-build
nix build
npm run dev
npm run web:dev
```

The API serves the built web UI from `dist/web` after `npm run web:build`. The
API defaults to `ws://127.0.0.1:5580/ws` for Matter and is not dry-run by
default. For a safe local UI preview without touching live Matter, run:

```sh
MATTER_LAYER_MATTER_ENABLED=0 MATTER_LAYER_DRY_RUN=1 MATTER_LAYER_PORT=3001 npm run dev
MATTER_LAYER_PORT=3001 npm run web:dev
```

To run with a custom rules module outside NixOS:

```sh
MATTER_LAYER_RULES_MODULE=$PWD/my-house/rules.ts \
MATTER_LAYER_BINDINGS_FILE=$PWD/my-house/bindings.json \
npm run dev
```
