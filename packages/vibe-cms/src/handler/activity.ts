import { and, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import { codeForStatus } from "../actions/errors.ts";
import { HttpError } from "../config.ts";
import { createDb } from "../db/client.ts";
import { activity, type ActivityRow } from "../db/schema.ts";
import type { Session } from "../server/index.ts";
import type { D1, ExecutionContext } from "./platform.ts";

/**
 * The activity log: who did what, when, through which channel, on what, and whether it worked.
 * The action dispatcher writes it (actions don't log themselves), so every core and plugin action is
 * covered. See `.docs/audit-log.md`.
 */

/** The channel an action came through. A header is a claim, for attribution only: the actor always comes from the session. */
export type Via = "ui" | "rest" | "mcp" | "cli" | "plugin" | "cron" | "hub";

export const VIA: readonly Via[] = ["ui", "rest", "mcp", "cli", "plugin", "cron", "hub"];

/** Channels a request may claim in `X-Vibe-Via`. The rest are set by the CMS itself. */
const CLAIMABLE = new Set<Via>(["ui", "rest", "cli", "mcp"]);

export const VIA_HEADER = "x-vibe-via";
export const CLIENT_HEADER = "x-vibe-client";

/** Where a request's actions came from: set by each entry point, read by the dispatcher. */
export interface ActivityScope {
  via: Via,
  /** MCP client, CLI version or user agent family. */
  client?: string,
  /** The person the system acted for, e.g. whoever scheduled a publish. */
  onBehalfOf?: string,
  /** Set for cron and hub work, which has no person behind the session. */
  system?: "cron" | "hub"
}

/** The channel a request claims, `rest` when it claims none (or one only the CMS sets). */
export function activityFromRequest(request: Request, fallback: Via = "rest"): ActivityScope {
  const claimed = request.headers.get(VIA_HEADER)?.trim().toLowerCase() as Via | undefined;
  const via = claimed && CLAIMABLE.has(claimed) ? claimed : fallback;
  const client = clean(request.headers.get(CLIENT_HEADER)) ?? userAgentFamily(request.headers.get("user-agent"));
  return { via, ...(client ? { client } : {}) };
}

/** `Mozilla/5.0 … Chrome/130…` → `Chrome`; `claude-code/2.1 (…)` → `claude-code/2.1`. Never the whole string. */
export function userAgentFamily(agent: string | null): string | undefined {
  if(!agent) return undefined;
  if(agent.startsWith("Mozilla/")) {
    for(const name of ["Edg", "OPR", "Firefox", "Chrome", "Safari"]) if(agent.includes(`${name}/`)) return name === "Edg" ? "Edge" : name === "OPR" ? "Opera" : name;
    return "Browser";
  }
  return clean(agent.split(/[\s(]/)[0]);
}

function clean(value: string | null | undefined): string | undefined {
  const text = value?.replace(/[^\w./@:+-]/g, "").slice(0, 64);
  return text || undefined;
}

/** One entry, as the dispatcher reports it. */
export interface ActivityInput {
  action: string,
  ok: boolean,
  error?: string,
  targetType?: string | null,
  targetId?: string | null,
  targetLabel?: string | null,
  locale?: string | null,
  summary?: Record<string, unknown> | null
}

/** Never written, whatever an action reports: tokens, passwords, passkey material, invite codes, email bodies. */
const SECRET = /token|password|secret|passkey|credential|invite|code|body|email|key/i;

function scrub(summary: Record<string, unknown> | null | undefined): string | null {
  if(!summary) return null;
  const kept = Object.fromEntries(Object.entries(summary).filter(([key, value]) => value !== undefined && !SECRET.test(key)));
  if(!Object.keys(kept).length) return null;
  const text = JSON.stringify(kept);
  // Short, by design: a pointer to what changed, not the change.
  return text.length > 2000 ? JSON.stringify({ truncated: true }) : text;
}

let lastTime = 0;
let sequence = 0;

/**
 * `act_` + time + a sequence + randomness: sorts by time, and within one millisecond by the order this
 * isolate wrote them. Entries from two isolates in the same millisecond sort either way.
 */
function activityId(at: number): string {
  sequence = at === lastTime ? sequence + 1 : 0;
  lastTime = at;
  const random = crypto.getRandomValues(new Uint8Array(6));
  let tail = "";
  for(const byte of random) tail += (byte % 36).toString(36);
  return `act_${at.toString(36).padStart(9, "0")}${sequence.toString(36).padStart(4, "0")}${tail}`;
}

/** The row an entry becomes. Null when there's nobody to attribute it to (an anonymous request). */
export function activityRow(scope: ActivityScope, session: Session | null, input: ActivityInput, at = Date.now()): ActivityRow | null {
  const system = scope.system ?? (session?.sub.startsWith("hub|") ? "hub" : undefined);
  if(!system && !session) return null;
  return {
    id: activityId(at),
    at,
    actor: system ? `system:${system}` : session!.sub,
    actor_name: system ? null : session!.name ?? null,
    via: system && scope.via !== "cron" ? system : scope.via,
    client: scope.client ?? null,
    on_behalf_of: scope.onBehalfOf ?? null,
    action: input.action,
    target_type: input.targetType ?? null,
    target_id: input.targetId ?? null,
    target_label: input.targetLabel?.slice(0, 200) ?? null,
    locale: input.locale ?? null,
    ok: input.ok ? 1 : 0,
    error: input.ok ? null : input.error ?? "ERROR",
    summary: scrub(input.summary)
  };
}

function failed(error: unknown) {
  console.error("vibe-cms: couldn't record activity", error);
}

/**
 * Writes entries. Recording never fails the action it records: a failed write is logged and dropped.
 * With an execution context the write runs after the response.
 */
export function recordActivity(db: D1, rows: Array<ActivityRow | null>, ctx?: ExecutionContext): Promise<void> | undefined {
  const values = rows.filter((row): row is ActivityRow => row !== null);
  if(!values.length) return undefined;
  let promise: Promise<void>;
  try {
    promise = createDb(db).insert(activity).values(values).then(() => {}, failed);
  } catch (error) {
    failed(error);
    return undefined;
  }
  if(ctx?.waitUntil) {
    ctx.waitUntil(promise);
    return undefined;
  }
  return promise;
}

/** What can record activity: the request's engine. */
interface Recorder {
  recordActivity(input: ActivityInput): unknown
}

/**
 * Runs a route that isn't an action (users, roles) and records it like one: success, or the refusal's
 * code. Input that didn't validate (400) and anonymous requests aren't recorded.
 */
export async function audited<T>(engine: Recorder, input: Omit<ActivityInput, "ok" | "error">, run: () => T | Promise<T>): Promise<T> {
  try {
    const result = await run();
    engine.recordActivity({ ...input, ok: true });
    return result;
  } catch (error) {
    const code = error instanceof HttpError ? codeForStatus(error.status) : "INTERNAL_SERVER_ERROR";
    if(code !== "BAD_REQUEST" && code !== "UNAUTHORIZED") engine.recordActivity({ ...input, ok: false, error: code });
    throw error;
  }
}

export interface ActivityFilter {
  actor?: string,
  via?: Via,
  /** An action name, or a group: `documents` matches `documents.publish`. */
  action?: string,
  targetId?: string,
  since?: number,
  until?: number,
  /** Only failures (`false`) or successes (`true`). */
  ok?: boolean,
  /** The last `id` of the previous page. */
  cursor?: string,
  limit?: number
}

export interface ActivityEntry {
  id: string,
  at: number,
  actor: string,
  actorName: string | null,
  via: string,
  client: string | null,
  onBehalfOf: string | null,
  action: string,
  targetType: string | null,
  targetId: string | null,
  targetLabel: string | null,
  locale: string | null,
  ok: boolean,
  error: string | null,
  summary: Record<string, unknown> | null
}

function entry(row: ActivityRow): ActivityEntry {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    actorName: row.actor_name,
    via: row.via,
    client: row.client,
    onBehalfOf: row.on_behalf_of,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: row.target_label,
    locale: row.locale,
    ok: row.ok === 1,
    error: row.error,
    summary: row.summary ? JSON.parse(row.summary) as Record<string, unknown> : null
  };
}

/** Newest first, a page at a time. */
export async function listActivity(db: D1, filter: ActivityFilter): Promise<{ entries: ActivityEntry[], next: string | null }> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const where: SQL[] = [];
  if(filter.actor) where.push(eq(activity.actor, filter.actor));
  if(filter.via) where.push(eq(activity.via, filter.via));
  if(filter.action) {
    // Whole names, or a group's: `documents` → `documents.%`.
    where.push(filter.action.includes(".") ? eq(activity.action, filter.action) : and(gte(activity.action, `${filter.action}.`), lt(activity.action, `${filter.action}/`))!);
  }
  if(filter.targetId) where.push(eq(activity.target_id, filter.targetId));
  if(filter.since !== undefined) where.push(gte(activity.at, filter.since));
  if(filter.until !== undefined) where.push(lte(activity.at, filter.until));
  if(filter.ok !== undefined) where.push(eq(activity.ok, filter.ok ? 1 : 0));
  if(filter.cursor) where.push(lt(activity.id, filter.cursor));
  const rows = await createDb(db).select().from(activity).where(where.length ? and(...where) : undefined).orderBy(desc(activity.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  return { entries: page.map(entry), next: rows.length > limit ? page[page.length - 1]!.id : null };
}

export const DEFAULT_ACTIVITY_DAYS = 90;

/** The cron trigger's pruning: the only thing that ever deletes entries. */
export async function pruneActivity(db: D1, days: number, now = Date.now()): Promise<void> {
  await createDb(db).delete(activity).where(lt(activity.at, now - days * 86_400_000));
}
