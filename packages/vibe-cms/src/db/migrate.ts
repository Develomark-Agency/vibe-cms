import type { D1 } from "../handler/platform.ts";

/** One migration, as `bun run db:generate` writes it: its name and its statements. */
export interface Migration {
  tag: string,
  statements: string[]
}

/**
 * Applies the migrations that haven't run, in order, and records each in `table`. Generated SQL is
 * written with `IF NOT EXISTS`, so a database made before migrations existed takes the first one as a
 * no-op. Concurrent isolates may both apply one; each statement is safe to repeat.
 */
export async function runMigrations(d1: D1, migrations: readonly Migration[], table: string): Promise<void> {
  await d1.prepare(`CREATE TABLE IF NOT EXISTS ${table} (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`).run();
  const { results } = await d1.prepare(`SELECT tag FROM ${table}`).all();
  const done = new Set((results as Array<{ tag: string }>).map(row => row.tag));
  for(const migration of migrations) {
    if(done.has(migration.tag)) continue;
    await d1.batch([
      ...migration.statements.map(sql => d1.prepare(sql)),
      d1.prepare(`INSERT OR IGNORE INTO ${table} (tag, applied_at) VALUES (?, ?)`).bind(migration.tag, Date.now())
    ]);
  }
}
