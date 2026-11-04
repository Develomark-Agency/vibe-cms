import type { Context } from "hono";
import type { Env, SessionRow } from "./shared.ts";

/** What every route sees: the Worker's bindings, and the signed-in editor once `requireSession` has run. */
export type AppEnv = {
  Bindings: Env,
  Variables: { session: SessionRow }
};

export type AppContext = Context<AppEnv>;

/** Starts work that outlives the response, where there's an execution context to keep it alive (a Worker; not under test). */
export function waitUntil(c: AppContext, start: () => Promise<unknown>) {
  let ctx: { waitUntil(work: Promise<unknown>): void };
  try {
    ctx = c.executionCtx;
  } catch {
    return;
  }
  ctx.waitUntil(start());
}
