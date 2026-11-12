import { and, asc, desc, eq, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { HttpError } from "../config.ts";
import { createDb } from "../db/client.ts";
import { meta, redirects, type RedirectRow } from "../db/schema.ts";
import { checkRule, findLoop, isWildcard, RedirectIndex, resolveRedirect, type MatchRule, type RedirectSource, type Resolved, type RuleInput } from "../redirects.ts";
import { getMeta, newId } from "./db.ts";
import type { D1, ExecutionContext } from "./platform.ts";

const VERSION_KEY = "redirects_version";
/** How often a running Worker asks whether the rules changed. Between checks, a request costs no query. */
const CHECK_EVERY = 5_000;
/** Hit counts are written at most this often per Worker instance. */
const FLUSH_EVERY = 5_000;
const FLUSH_AT = 100;

/** A rule as the API returns it. */
export interface Redirect {
  id: string,
  from: string,
  to: string,
  status: number,
  keepQuery: boolean,
  locale: string | null,
  source: RedirectSource,
  documentId: string | null,
  documentType: string | null,
  createdBy: string | null,
  createdAt: string,
  hits: number,
  lastHitAt: string | null
}

export function toRedirect(row: RedirectRow): Redirect {
  return {
    id: row.id,
    from: row.from,
    to: row.to,
    status: row.status,
    keepQuery: row.keep_query === 1,
    locale: row.locale,
    source: row.source,
    documentId: row.document_id,
    documentType: row.document_type,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    hits: row.hits,
    lastHitAt: row.last_hit_at === null ? null : new Date(row.last_hit_at).toISOString()
  };
}

function matchRule(row: Pick<RedirectRow, "id" | "from" | "to" | "status" | "keep_query">): MatchRule {
  return { id: row.id, from: row.from, to: row.to, status: row.status, keepQuery: row.keep_query === 1 };
}

export interface RedirectFilter {
  search?: string,
  source?: RedirectSource,
  limit?: number,
  offset?: number
}

export interface SaveOptions {
  source: RedirectSource,
  documentId?: string | null,
  documentType?: string | null,
  locale?: string | null,
  by: string | null,
  /** Replace a rule that already has this `from` instead of refusing. Used for automatic rules. */
  replace?: boolean
}

/**
 * The site's redirect rules: storage, and the in-memory copy requests are matched against. One per
 * isolate. Rules are reloaded when `vibe_meta.redirects_version` changes, checked every few seconds.
 */
export class RedirectStore {
  private index: RedirectIndex | null = null;
  private version: string | null = null;
  private checkedAt = 0;
  private loading: Promise<RedirectIndex> | null = null;
  private pending = new Map<string, number>();
  private lastFlush = 0;

  constructor(private readonly db: D1, private readonly prefix: string) {}

  private get orm() {
    return createDb(this.db);
  }

  private batch(items: Array<BatchItem<"sqlite">>) {
    return this.orm.batch(items as [BatchItem<"sqlite">, ...Array<BatchItem<"sqlite">>]);
  }

  // --- Serving ---------------------------------------------------------------------

  /** The rules to match against: from memory, checked against the database's version every few seconds. */
  async current(now = Date.now()): Promise<RedirectIndex> {
    if(this.index && now - this.checkedAt < CHECK_EVERY) return this.index;
    if(this.loading) return this.loading;
    this.loading = this.refresh(now).finally(() => (this.loading = null));
    return this.loading;
  }

  private async refresh(now: number): Promise<RedirectIndex> {
    const version = (await getMeta(this.db, VERSION_KEY)) ?? "";
    if(this.index && version === this.version) {
      this.checkedAt = now;
      return this.index;
    }
    const rows = await this.orm.select({ id: redirects.id, from: redirects.from, to: redirects.to, status: redirects.status, keep_query: redirects.keep_query }).from(redirects);
    this.index = new RedirectIndex(rows.map(matchRule));
    this.version = version;
    this.checkedAt = now;
    return this.index;
  }

  /** The redirect for a request, counting the hit in the background. Null when no rule applies. */
  async resolve(url: URL, ctx?: ExecutionContext): Promise<Resolved | null> {
    const index = await this.current();
    if(index.size === 0) return null;
    const resolved = resolveRedirect(index, url);
    if(resolved) this.hit(resolved.rule.id, ctx);
    return resolved;
  }

  private hit(id: string, ctx?: ExecutionContext) {
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
    const now = Date.now();
    if(now - this.lastFlush < FLUSH_EVERY && this.pending.size < FLUSH_AT) return;
    this.lastFlush = now;
    const counts = [...this.pending];
    this.pending = new Map();
    const write = this.db.batch(counts.map(([rule, hits]) => this.db.prepare("UPDATE vibe_redirects SET hits = hits + ?, last_hit_at = ? WHERE id = ?").bind(hits, now, rule))).catch(error => {
      console.error("vibe-cms: couldn't record redirect hits", error);
    });
    ctx?.waitUntil?.(write);
  }

  /** Makes the next request reload the rules, for writes made in this isolate. */
  invalidate() {
    this.checkedAt = 0;
    this.version = null;
  }

  // --- Reading ---------------------------------------------------------------------

  async list(filter: RedirectFilter = {}): Promise<{ redirects: Redirect[], total: number }> {
    const terms: SQL[] = [];
    const search = filter.search?.trim();
    if(search) {
      const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      terms.push(or(sql`${redirects.from} LIKE ${pattern} ESCAPE '\\'`, sql`${redirects.to} LIKE ${pattern} ESCAPE '\\'`)!);
    }
    if(filter.source) terms.push(eq(redirects.source, filter.source));
    const where = terms.length ? and(...terms) : undefined;
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      this.orm.select().from(redirects).where(where).orderBy(desc(redirects.created_at), asc(redirects.from)).limit(filter.limit ?? 50).offset(filter.offset ?? 0),
      this.orm.select({ total: sql<number>`count(*)` }).from(redirects).where(where)
    ]);
    return { redirects: rows.map(toRedirect), total };
  }

  async get(id: string): Promise<RedirectRow | null> {
    return (await this.orm.select().from(redirects).where(eq(redirects.id, id)).limit(1))[0] ?? null;
  }

  async byFrom(from: string): Promise<RedirectRow | null> {
    return (await this.orm.select().from(redirects).where(eq(redirects.from, from)).limit(1))[0] ?? null;
  }

  async forDocument(documentId: string): Promise<RedirectRow[]> {
    return this.orm.select().from(redirects).where(eq(redirects.document_id, documentId));
  }

  async all(): Promise<RedirectRow[]> {
    return this.orm.select().from(redirects);
  }

  private bump() {
    return this.orm.insert(meta).values({ key: VERSION_KEY, value: newId("v") }).onConflictDoUpdate({ target: meta.key, set: { value: newId("v") } });
  }

  // --- Writing ---------------------------------------------------------------------

  /**
   * Adds a rule, or with `id` changes one. Checks it, then: refuses a `from` that's taken (or replaces it
   * with `replace`), refuses loops, and points rules that led to this rule's `from` at its `to` so
   * nobody is sent through more than one hop. Returns the rule and the rules it re-pointed.
   */
  async save(input: RuleInput, options: SaveOptions, id?: string): Promise<{ row: RedirectRow, repointed: RedirectRow[] }> {
    let checked;
    try {
      checked = checkRule(input, this.prefix);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    const rows = await this.all();
    const taken = rows.find(row => row.from === checked.from && row.id !== id);
    if(taken && !options.replace) throw new HttpError(409, `There's already a redirect from ${checked.from}`);
    const replaced = taken?.id;
    const existing = id ? rows.find(row => row.id === id) : undefined;
    if(id && !existing) throw new HttpError(404, "Redirect not found");
    const ownId = replaced ?? id ?? newId("redir");
    // Rules that sent visitors to this path now send them to where it goes.
    const repointed: RedirectRow[] = [];
    const removed: string[] = [];
    if(!isWildcard(checked.from)) {
      for(const row of rows) {
        if(row.id === ownId || isWildcard(row.to) || row.to !== checked.from) continue;
        // An automatic rule going back to where it started cancels the rule that left (the page moved back); a person's is a loop.
        if(row.from === checked.to) {
          if(options.replace) removed.push(row.id);
        } else {
          repointed.push({ ...row, to: checked.to });
        }
      }
    }
    const after = rows.filter(row => row.id !== ownId && !removed.includes(row.id)).map(row => matchRule(repointed.find(r => r.id === row.id) ?? row));
    const loop = findLoop(after, { id: ownId, from: checked.from, to: checked.to, status: checked.status, keepQuery: checked.keepQuery });
    if(loop) throw new HttpError(409, `That would loop: ${loop.join(" → ")}`);
    const values = {
      from: checked.from,
      to: checked.to,
      status: checked.status,
      keep_query: checked.keepQuery ? 1 : 0,
      locale: options.locale ?? existing?.locale ?? null,
      source: options.source,
      document_id: options.documentId ?? null,
      document_type: options.documentType ?? null
    };
    const statements: Array<BatchItem<"sqlite">> = [];
    if(replaced) statements.push(this.orm.delete(redirects).where(eq(redirects.id, replaced)));
    if(existing && !replaced) statements.push(this.orm.update(redirects).set(values).where(eq(redirects.id, ownId)));
    else statements.push(this.orm.insert(redirects).values({ id: ownId, ...values, created_by: options.by, created_at: Date.now() }));
    for(const row of repointed) statements.push(this.orm.update(redirects).set({ to: row.to }).where(eq(redirects.id, row.id)));
    for(const rule of removed) statements.push(this.orm.delete(redirects).where(eq(redirects.id, rule)));
    statements.push(this.bump());
    await this.batch(statements);
    this.invalidate();
    return { row: (await this.get(ownId))!, repointed };
  }

  async remove(id: string): Promise<RedirectRow> {
    const row = await this.get(id);
    if(!row) throw new HttpError(404, "Redirect not found");
    await this.batch([this.orm.delete(redirects).where(eq(redirects.id, id)), this.bump()]);
    this.invalidate();
    return row;
  }

  /** Deletes a document's automatic rules, optionally only those from `from` or of one `source`. */
  async removeAutomatic(documentId: string, where: { from?: string, source?: RedirectSource } = {}): Promise<number> {
    const terms = [eq(redirects.document_id, documentId)];
    if(where.from) terms.push(eq(redirects.from, where.from));
    if(where.source) terms.push(eq(redirects.source, where.source));
    const rows = await this.orm.select({ id: redirects.id }).from(redirects).where(and(...terms));
    if(!rows.length) return 0;
    await this.batch([this.orm.delete(redirects).where(and(...terms)), this.bump()]);
    this.invalidate();
    return rows.length;
  }
}
