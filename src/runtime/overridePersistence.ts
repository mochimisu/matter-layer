import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LayerOutput } from "./types";

export type PersistedOverrideItem = {
  target: string;
  key: string;
  output: LayerOutput;
};

export class OverridePersistence {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists override_layers (
        target text not null,
        key text not null,
        state text not null,
        reason text,
        writer text,
        expires_at integer,
        updated_at integer not null,
        primary key (target, key)
      )
    `);
  }

  load(now = Date.now()): PersistedOverrideItem[] {
    const rows = this.db.prepare(`
      select target, key, state, reason, writer, expires_at as expiresAt
      from override_layers
      where expires_at is null or expires_at > ?
      order by target, updated_at
    `).all(now) as Array<{
      target: string;
      key: string;
      state: string;
      reason?: string | null;
      writer?: string | null;
      expiresAt?: number | null;
    }>;
    this.db.prepare("delete from override_layers where expires_at is not null and expires_at <= ?").run(now);
    return rows.map((row) => ({
      target: row.target,
      key: row.key,
      output: {
        state: JSON.parse(row.state),
        reason: row.reason ?? undefined,
        writer: row.writer ?? undefined,
        expiresAt: row.expiresAt ?? undefined,
      },
    }));
  }

  replaceTarget(target: string, items: Array<{ key: string; output: LayerOutput }>) {
    this.db.exec("begin immediate");
    try {
      this.db.prepare("delete from override_layers where target = ?").run(target);
      const insert = this.db.prepare(`
        insert into override_layers (target, key, state, reason, writer, expires_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = Date.now();
      for (const item of items) {
        if (item.output.state === null) continue;
        insert.run(
          target,
          item.key,
          JSON.stringify(item.output.state),
          item.output.reason ?? null,
          item.output.writer ?? null,
          item.output.expiresAt ?? null,
          now,
        );
      }
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
