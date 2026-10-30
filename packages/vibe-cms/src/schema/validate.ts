import type {
  AnySchema,
  ArraySchema,
  AssetSchema,
  DateSchema,
  EnumSchema,
  LiteralSchema,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  RefSchema,
  Shape,
  TextSchema,
  UnionSchema,
  JsonObject,
  JsonValue
} from "./types.ts";

export type Path = Array<string | number>;

export interface Issue {
  path: Path,
  message: string
}

export interface ValidationResult<T = unknown> {
  value: T,
  issues: Issue[]
}

export const formats: Record<string, [RegExp, string]> = {
  email: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Must be an email address"],
  url: [/^(https?:\/\/|\/)\S*$/, "Must be a URL"],
  slug: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Must be lowercase letters, numbers and dashes"],
  path: [/^\/(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_.][a-z0-9]+)*)*)?$/, "Must be a path like /about/team: lowercase, starting with / and without a trailing /"]
};

/**
 * Validates and normalizes a value against a schema. Unknown object keys are
 * dropped, `Date` instances become ISO strings. References and assets are only
 * checked for shape here; existence is checked by the engine.
 */
export function validate<T = unknown>(schema: AnySchema, value: unknown): ValidationResult<T> {
  const issues: Issue[] = [];
  const result = check(schema, value, [], issues);
  return { value: result as T, issues };
}

function check(schema: AnySchema, value: unknown, path: Path, issues: Issue[]): unknown {
  function fail(message: string) {
    issues.push({ path, message });
    return value;
  }

  if(schema.type === "optional") {
    if(value === undefined || value === null) return undefined;
    return check((schema as OptionalSchema).inner, value, path, issues);
  }
  if(value === undefined || value === null) {
    if(schema.type === "literal" && (schema as LiteralSchema).value === null) return null;
    return fail("Required");
  }

  switch(schema.type) {
    case "text": {
      const s = schema as TextSchema;
      if(typeof value !== "string") return fail("Must be text");
      if(s.min !== undefined && value.length < s.min) {
        return fail(s.min === 1 ? "Required" : `Must be at least ${s.min} characters`);
      }
      if(s.max !== undefined && value.length > s.max) return fail(`Must be at most ${s.max} characters`);
      if(s.format && value !== "") {
        const [pattern, message] = formats[s.format]!;
        if(!pattern.test(value)) return fail(message);
      }
      if(s.pattern && !new RegExp(s.pattern).test(value)) return fail("Invalid format");
      return value;
    }
    case "number": {
      const s = schema as NumberSchema;
      if(typeof value !== "number" || Number.isNaN(value)) return fail("Must be a number");
      if(s.integer && !Number.isInteger(value)) return fail("Must be a whole number");
      if(s.min !== undefined && value < s.min) return fail(`Must be at least ${s.min}`);
      if(s.max !== undefined && value > s.max) return fail(`Must be at most ${s.max}`);
      return value;
    }
    case "boolean":
      return typeof value === "boolean" ? value : fail("Must be true or false");
    case "date": {
      const s = schema as DateSchema;
      const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
      if(!date || Number.isNaN(date.getTime())) return fail("Must be a date");
      if(!s.time && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
      return s.time ? date.toISOString() : date.toISOString().slice(0, 10);
    }
    case "literal":
      return value === (schema as LiteralSchema).value ? value : fail(`Must be ${JSON.stringify((schema as LiteralSchema).value)}`);
    case "enum": {
      const s = schema as EnumSchema;
      return typeof value === "string" && s.values.includes(value) ? value : fail(`Must be one of ${s.values.join(", ")}`);
    }
    case "array": {
      const s = schema as ArraySchema;
      if(!Array.isArray(value)) return fail("Must be a list");
      if(s.min !== undefined && value.length < s.min) return fail(`Must have at least ${s.min} items`);
      if(s.max !== undefined && value.length > s.max) return fail(`Must have at most ${s.max} items`);
      return value.map((item, i) => check(s.item, item, [...path, i], issues));
    }
    case "object":
      return checkShape((schema as ObjectSchema).shape, value, path, issues);
    case "union":
      return checkUnion(schema as UnionSchema, value, path, issues);
    case "ref": {
      const s = schema as RefSchema;
      if(s.to !== undefined) return typeof value === "string" && value ? value : fail("Must be a document ID");
      const ref = value as { type?: unknown, id?: unknown };
      if(typeof ref !== "object" || typeof ref.type !== "string" || typeof ref.id !== "string") {
        return fail("Must be a reference");
      }
      return { type: ref.type, id: ref.id };
    }
    case "asset": {
      const s = schema as AssetSchema;
      const asset = value as { asset?: unknown };
      if(typeof asset !== "object" || typeof asset.asset !== "string") return fail("Must be an asset");
      const fields = checkShape(s.fields, value, path, issues);
      return { asset: asset.asset, ...(isRecord(fields) ? fields : {}) };
    }
    default:
      return fail(`Unknown field type "${schema.type}"`);
  }
}

/** Input arrives as untrusted JSON; this is the one place it's treated as a plain object. */
export function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkShape(shape: Shape, value: unknown, path: Path, issues: Issue[]) {
  if(!isRecord(value)) {
    issues.push({ path, message: "Must be an object" });
    return value;
  }
  const out: { [key: string]: unknown } = {};
  for(const [key, field] of Object.entries(shape)) {
    const result = check(field, value[key], [...path, key], issues);
    if(result !== undefined) out[key] = result;
  }
  return out;
}

function checkUnion(schema: UnionSchema, value: unknown, path: Path, issues: Issue[]) {
  const candidates = schema.options.filter(option => matchesDiscriminators(option, value));
  let best: { value: unknown, issues: Issue[] } | undefined;
  for(const option of candidates.length ? candidates : schema.options) {
    const attempt: Issue[] = [];
    const result = check(option, value, path, attempt);
    if(attempt.length === 0) return result;
    if(!best || attempt.length < best.issues.length) best = { value: result, issues: attempt };
  }
  if(!best) {
    issues.push({ path, message: "No matching variant" });
    return value;
  }
  issues.push(...best.issues);
  return best.value;
}

/** Union variants are told apart by their literal fields (e.g. `kind: v.literal("p")`). */
export function matchesDiscriminators(option: AnySchema, value: unknown): boolean {
  if(option.type !== "object") return false;
  if(typeof value !== "object" || value === null) return false;
  const literals = Object.entries((option as ObjectSchema).shape).filter(([, s]) => s.type === "literal");
  if(literals.length === 0) return false;
  return isRecord(value) && literals.every(([key, s]) => value[key] === (s as LiteralSchema).value);
}

export interface FoundReference {
  kind: "ref" | "asset",
  schema: RefSchema | AssetSchema,
  value: unknown,
  path: Path
}

/** Finds every reference and asset in a (validated) value, following the schema. */
export function findReferences(schema: AnySchema, value: unknown, path: Path = []): FoundReference[] {
  const found: FoundReference[] = [];
  function visit(s: AnySchema, v: unknown, p: Path) {
    if(v === undefined || v === null) return;
    switch(s.type) {
      case "optional":
        return visit((s as OptionalSchema).inner, v, p);
      case "ref":
        found.push({ kind: "ref", schema: s as RefSchema, value: v, path: p });
        return;
      case "asset":
        found.push({ kind: "asset", schema: s as AssetSchema, value: v, path: p });
        for(const [key, field] of Object.entries((s as AssetSchema).fields)) {
          visit(field, isRecord(v) ? v[key] : undefined, [...p, key]);
        }
        return;
      case "array":
        if(Array.isArray(v)) v.forEach((item, i) => visit((s as ArraySchema).item, item, [...p, i]));
        return;
      case "object":
        for(const [key, field] of Object.entries((s as ObjectSchema).shape)) {
          visit(field, isRecord(v) ? v[key] : undefined, [...p, key]);
        }
        return;
      case "union": {
        const option = pickUnionOption(s as UnionSchema, v);
        if(option) visit(option, v, p);
      }
    }
  }
  visit(schema, value, path);
  return found;
}

export function pickUnionOption(schema: UnionSchema, value: unknown): AnySchema | undefined {
  const matched = schema.options.find(option => matchesDiscriminators(option, value));
  if(matched) return matched;
  return schema.options.find(option => validate(option, value).issues.length === 0);
}

/** Resolves a field path (`["seo", "description"]`) to its schema. */
export function schemaAt(schema: AnySchema, path: Path): AnySchema | undefined {
  let current: AnySchema | undefined = schema;
  for(const key of path) {
    while(current?.type === "optional") current = (current as OptionalSchema).inner;
    if(!current) return undefined;
    if(current.type === "object") current = (current as ObjectSchema).shape[key];
    else if(current.type === "array") current = (current as ArraySchema).item;
    else if(current.type === "asset") current = (current as AssetSchema).fields[key];
    else return undefined;
  }
  return current;
}

/** Builds an empty value for a schema, used when creating documents and list items. */
export function emptyValue(schema: AnySchema): JsonValue | undefined {
  switch(schema.type) {
    case "optional": return undefined;
    case "text": return "";
    case "number": return 0;
    case "boolean": return false;
    case "date": return undefined;
    case "literal": return (schema as LiteralSchema).value;
    case "enum": return (schema as EnumSchema).values[0];
    case "array": return [];
    case "object": {
      const out: JsonObject = {};
      for(const [key, field] of Object.entries((schema as ObjectSchema).shape)) {
        const value = emptyValue(field);
        if(value !== undefined) out[key] = value;
      }
      return out;
    }
    case "union": return emptyValue((schema as UnionSchema).options[0]!);
    default: return undefined;
  }
}
