import { getSchema, type AnyConfig } from "../config.ts";
import { documentUrl, normalizePath } from "../redirects.ts";
import type { EnumSchema, OptionalSchema, TextSchema } from "../schema/types.ts";
import { all } from "./db.ts";
import type { D1 } from "./platform.ts";

/** How long a Worker keeps its list of hidden pages before asking again. */
const CHECK_EVERY = 5_000;

/** The value of a page's `visibility` field that keeps it out of search results. */
export const NOINDEX_VISIBILITY = "noindex";

function unwrapField(field: unknown) {
  const schema = field as OptionalSchema | undefined;
  return schema?.type === "optional" ? schema.inner : schema;
}

/** Whether a content type can hide its pages: it has a `visibility` field that can be `noindex`. */
function hidesPages(config: AnyConfig, type: string): boolean {
  const field = unwrapField(getSchema(config, type).shape.visibility) as EnumSchema | undefined;
  return field?.type === "enum" && field.values.includes(NOINDEX_VISIBILITY);
}

function hasPathField(config: AnyConfig, type: string): boolean {
  const field = unwrapField(getSchema(config, type).shape.path) as TextSchema | undefined;
  return field?.type === "text" && field.format === "path";
}

/**
 * The pages editors have marked "hide from search results": a set of addresses kept in memory and
 * reloaded every few seconds, so a request costs no query. Only published copies count.
 */
export class NoindexPages {
  private paths: Set<string> | null = null;
  private checkedAt = 0;
  private loading: Promise<Set<string>> | null = null;
  private readonly types: string[];

  constructor(private readonly db: D1, private readonly config: AnyConfig) {
    this.types = Object.keys(config.schemas).filter(type => hidesPages(config, type));
  }

  /** Whether the site has any content type that can hide its pages. Without one, no request needs a lookup. */
  get enabled(): boolean {
    return this.types.length > 0;
  }

  async has(pathname: string, now = Date.now()): Promise<boolean> {
    if(!this.enabled) return false;
    return (await this.current(now)).has(normalizePath(pathname));
  }

  private async current(now: number): Promise<Set<string>> {
    if(this.paths && now - this.checkedAt < CHECK_EVERY) return this.paths;
    if(this.loading) return this.loading;
    this.loading = this.load(now).finally(() => (this.loading = null));
    return this.loading;
  }

  private async load(now: number): Promise<Set<string>> {
    const paths = new Set<string>();
    for(const type of this.types) {
      const rows = await all<{ id: string, locale: string, published: string }>(
        this.db,
        "SELECT id, locale, published FROM vibe_documents WHERE type = ? AND published IS NOT NULL AND json_extract(published, '$.visibility') = ?",
        [type, NOINDEX_VISIBILITY]
      );
      for(const row of rows) {
        const url = documentUrl(this.config.collections?.[type], hasPathField(this.config, type), JSON.parse(row.published), row.id, row.locale);
        if(url) paths.add(url);
      }
    }
    this.paths = paths;
    this.checkedAt = now;
    return paths;
  }

  /** Makes the next request reload the list, for writes made in this isolate. */
  invalidate() {
    this.checkedAt = 0;
  }
}
