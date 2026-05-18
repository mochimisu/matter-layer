import fs from "node:fs";

export type AppConfig = {
  matterWsUrl: string;
  dryRun: boolean;
  matterEnabled: boolean;
  port: number;
  rulesModule?: string;
  matterBindings: Record<string, MatterBinding>;
};

export type MatterBinding = {
  label?: string;
  mac?: string;
};

export function loadConfig(env = process.env): AppConfig {
  return {
    matterWsUrl: env.MATTER_LAYER_MATTER_WS_URL ?? "ws://127.0.0.1:5580/ws",
    dryRun: env.MATTER_LAYER_DRY_RUN === "1",
    matterEnabled: env.MATTER_LAYER_MATTER_ENABLED !== "0",
    port: Number(env.MATTER_LAYER_PORT ?? 3000),
    rulesModule: env.MATTER_LAYER_RULES_MODULE,
    matterBindings: loadMatterBindings(env),
  };
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
  return parsed as Record<string, MatterBinding>;
}

function readOptionalFile(file?: string) {
  if (!file) {
    return undefined;
  }
  return fs.readFileSync(file, "utf8");
}
