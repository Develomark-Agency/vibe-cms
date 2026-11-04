import { HttpError } from "../config.ts";
import type { Condition, Order } from "../query/index.ts";

const metaColumns: Record<string, string> = {
  id: "id",
  $updatedAt: "updated_at",
  $createdAt: "created_at",
  $publishedAt: "published_at"
};

/** `["seo", "description"]` → `'$."seo"."description"'`, literal so expression indexes match. */
export function jsonPath(path: readonly string[]): string {
  let out = "$";
  for(const segment of path) {
    if(/^\d+$/.test(segment)) out += `[${segment}]`;
    else if(/^[\w-]+$/.test(segment)) out += `."${segment}"`;
    else throw new HttpError(400, `Invalid field path segment "${segment}"`);
  }
  return `'${out}'`;
}

function bindable(value: unknown, path: readonly string[]): unknown {
  if(typeof value === "boolean") return value ? 1 : 0;
  if(path.length === 1 && path[0] !== "id" && metaColumns[path[0]!] && typeof value === "string") {
    return Date.parse(value);
  }
  return value;
}

/** The words of a search, lowercased, as the index tokenizes them. */
export function searchWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** An FTS5 query where every word must match as a prefix: `"furn"* "pad"*`. Never empty. */
export function ftsQuery(text: string): string {
  const words = searchWords(text);
  return words.length ? words.map(word => `"${word}"*`).join(" ") : "\"\"";
}

export class SqlBuilder {
  readonly params: unknown[] = [];

  constructor(readonly dataColumn: string) {}

  column(path: readonly string[]): string {
    const meta = path.length === 1 ? metaColumns[path[0]!] : undefined;
    if(meta) return meta;
    return `json_extract(${this.dataColumn}, ${jsonPath(path)})`;
  }

  param(value: unknown): string {
    this.params.push(value);
    return "?";
  }

  where(condition: Condition | undefined): string {
    if(!condition) return "1";
    switch(condition.op) {
      case "eq":
        if(condition.value === null) return `${this.column(condition.path)} IS NULL`;
        return `${this.column(condition.path)} = ${this.param(bindable(condition.value, condition.path))}`;
      case "ne":
        if(condition.value === null) return `${this.column(condition.path)} IS NOT NULL`;
        return `${this.column(condition.path)} IS NOT ${this.param(bindable(condition.value, condition.path))}`;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[condition.op];
        return `${this.column(condition.path)} ${op} ${this.param(bindable(condition.value, condition.path))}`;
      }
      case "like":
        return `${this.column(condition.path)} LIKE ${this.param(condition.value)}`;
      case "has":
        return `EXISTS (SELECT 1 FROM json_each(${this.dataColumn}, ${jsonPath(condition.path)}) WHERE value = ${this.param(bindable(condition.value, []))})`;
      case "in":
      case "nin": {
        if(condition.values.length === 0) return condition.op === "in" ? "0" : "1";
        const list = condition.values.map(v => this.param(bindable(v, condition.path))).join(", ");
        return `${this.column(condition.path)} ${condition.op === "in" ? "IN" : "NOT IN"} (${list})`;
      }
      case "null":
        return `${this.column(condition.path)} IS NULL`;
      case "notNull":
        return `${this.column(condition.path)} IS NOT NULL`;
      case "and":
      case "or": {
        if(condition.conditions.length === 0) return condition.op === "and" ? "1" : "0";
        return `(${condition.conditions.map(c => this.where(c)).join(condition.op === "and" ? " AND " : " OR ")})`;
      }
      case "not":
        return `NOT (${this.where(condition.condition)})`;
      case "fulltext":
        // The index holds working copies, so it can't filter published content without revealing drafts.
        if(this.dataColumn !== "c.draft") throw new HttpError(400, "Full-text search covers drafts only");
        return `c.id IN (SELECT id FROM vibe_search WHERE vibe_search MATCH ${this.param(ftsQuery(condition.value))})`;
      case "search":
        return `${this.dataColumn} LIKE ${this.param(`%${condition.value.replace(/[%_]/g, "")}%`)}`;
      default:
        throw new HttpError(400, `Unknown condition "${(condition as { op: string }).op}"`);
    }
  }

  orderBy(orders: readonly Order[] | undefined, fallback: string): string {
    if(!orders?.length) return fallback;
    return orders.map(o => `${this.column(o.path)} ${o.dir === "desc" ? "DESC" : "ASC"}`).join(", ");
  }
}
