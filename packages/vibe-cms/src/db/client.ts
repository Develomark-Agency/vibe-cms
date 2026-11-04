import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import type { D1 } from "../handler/platform.ts";

/** The typed query builder over a D1 binding. */
export type Db = SqliteRemoteDatabase;

const cache = new WeakMap<D1, Db>();

/**
 * Drizzle over D1. It goes through D1's `prepare`, `raw` and `batch`, so `db.batch([...])` is one
 * atomic request like `D1.batch`. D1 has no interactive transactions; use `batch`.
 */
export function createDb(d1: D1): Db {
  const cached = cache.get(d1);
  if(cached) return cached;
  async function run(sql: string, params: unknown[], method: "run" | "all" | "values" | "get") {
    const statement = d1.prepare(sql).bind(...params);
    if(method === "run") {
      await statement.run();
      return { rows: [] };
    }
    const rows = await statement.raw();
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  }
  const db = drizzle(
    run,
    async batch => {
      const out = await d1.batch(batch.map(item => d1.prepare(item.sql).bind(...item.params)));
      return Promise.all(batch.map(async (item, i) => {
        if(item.method === "run") return { rows: [] };
        const rows = out[i]?.results ?? [];
        // `batch` returns objects, not arrays; Drizzle wants values in column order.
        const values = rows.map(row => Array.isArray(row) ? row : Object.values(row as object));
        return { rows: item.method === "get" ? (values[0] ?? []) : values };
      }));
    }
  );
  cache.set(d1, db);
  return db;
}
