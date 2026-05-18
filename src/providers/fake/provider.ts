import { makeUpdate } from "../../runtime/sources";
import type { DesiredCommand, ProviderAdapter, SourceId } from "../../runtime/types";

export class FakeProvider implements ProviderAdapter {
  readonly name: "fake" | "matter";
  readonly commands: DesiredCommand[] = [];

  constructor(private runtime?: { updateSource(update: any): void }, name: "fake" | "matter" = "matter") {
    this.name = name;
  }

  attach(runtime: { updateSource(update: any): void }) {
    this.runtime = runtime;
  }

  emit(source: SourceId, value: unknown) {
    if (!this.runtime) {
      throw new Error("FakeProvider is not attached");
    }
    this.runtime.updateSource(makeUpdate(source, value, "fake"));
  }

  async apply(command: DesiredCommand) {
    this.commands.push(command);
    return {
      command,
      provider: this.name,
      dryRun: true,
      ok: true,
      appliedAt: Date.now(),
    };
  }
}
