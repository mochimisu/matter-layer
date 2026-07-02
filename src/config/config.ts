import fs from "node:fs";
import path from "node:path";

export type AppConfig = {
  matterWsUrl: string;
  dryRun: boolean;
  matterEnabled: boolean;
  matterRemoteKeepaliveEnabled: boolean;
  haWsUrl: string;
  haToken?: string;
  haEnabled: boolean;
  port: number;
  dbPath: string;
  rulesModule?: string;
  matterBindings: Record<string, MatterBinding>;
};

export type MatterBinding = {
  label?: string;
  unique_id?: string;
  unique_id_env?: string;
  mac?: string;
};

export function loadConfig(env = process.env): AppConfig {
  return {
    matterWsUrl: env.MATTER_LAYER_MATTER_WS_URL ?? "ws://127.0.0.1:5580/ws",
    dryRun: env.MATTER_LAYER_DRY_RUN === "1",
    matterEnabled: env.MATTER_LAYER_MATTER_ENABLED !== "0",
    matterRemoteKeepaliveEnabled: envFlag(env.MATTER_LAYER_MATTER_REMOTE_KEEPALIVE_ENABLED ?? env.MATTER_REMOTE_KEEPALIVE_ENABLE, false),
    haWsUrl: env.MATTER_LAYER_HA_WS_URL ?? "ws://127.0.0.1:8123/api/websocket",
    haToken: env.MATTER_LAYER_HA_TOKEN ?? env.MATTER_HA_TOKEN,
    haEnabled: env.MATTER_LAYER_HA_ENABLED !== "0",
    port: Number(env.MATTER_LAYER_PORT ?? 3000),
    dbPath: env.MATTER_LAYER_DB_PATH ?? defaultDbPath(env),
    rulesModule: env.MATTER_LAYER_RULES_MODULE,
    matterBindings: loadMatterBindings(env),
  };
}

function envFlag(value: string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() !== "0" && value.toLowerCase() !== "false";
}

function loadMatterBindings(env: NodeJS.ProcessEnv): Record<string, MatterBinding> {
  const raw = env.MATTER_LAYER_BINDINGS_JSON ?? readOptionalFile(env.MATTER_LAYER_BINDINGS_FILE);
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MATTER_LAYER_BINDINGS_JSON must be an object");
  }
  return expandMatterBindings(parsed as Record<string, MatterBinding>, env);
}

function expandMatterBindings(bindings: Record<string, MatterBinding>, env: NodeJS.ProcessEnv): Record<string, MatterBinding> {
  const expanded: Record<string, MatterBinding> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    const next: MatterBinding = { ...binding };
    if (!next.unique_id && next.unique_id_env) {
      const value = env[next.unique_id_env]?.trim();
      if (value) {
        next.unique_id = value;
      }
    }
    expanded[key] = next;
  }
  return expanded;
}

function readOptionalFile(file?: string) {
  if (!file) {
    return undefined;
  }
  return fs.readFileSync(file, "utf8");
}

function defaultDbPath(env: NodeJS.ProcessEnv) {
  const stateHome = env.XDG_STATE_HOME ?? (env.HOME ? path.join(env.HOME, ".local", "state") : process.cwd());
  return path.join(stateHome, "matter-layer", "matter-layer.sqlite");
}
