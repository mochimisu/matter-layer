import path from "node:path";
import { pathToFileURL } from "node:url";
import fg from "fast-glob";
import type { RoomModule, Ruleset } from "./dsl";

export async function loadRules(root: string): Promise<Ruleset> {
  const deviceFiles = await fg("*.devices.ts", { cwd: root, absolute: true });
  const ruleFiles = await fg("*.rules.ts", { cwd: root, absolute: true });
  const devices = await loadModules(deviceFiles.sort());
  const rules = await loadModules(ruleFiles.sort());
  return { devices, rules };
}

export async function loadRulesModule(modulePath?: string | null): Promise<Ruleset> {
  if (!modulePath) {
    const imported = await import("../rules");
    return imported.default;
  }
  const imported = await import(pathToFileURL(path.resolve(modulePath)).href);
  return imported.default;
}

async function loadModules(files: string[]): Promise<RoomModule[]> {
  const modules: RoomModule[] = [];
  for (const file of files) {
    const imported = await import(pathToFileURL(path.resolve(file)).href);
    modules.push(imported.default);
  }
  return modules;
}
