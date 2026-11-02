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
  UnionSchema
} from "./types.ts";
import { formats, validate } from "./validate.ts";

// The Standard Schema and Standard JSON Schema interfaces (https://standardschema.dev), copied as the spec suggests.

export interface StandardTypes<Input = unknown, Output = Input> {
  readonly input: Input,
  readonly output: Output
}

export interface StandardIssue {
  readonly message: string,
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

export type StandardResult<Output> = { readonly value: Output, readonly issues?: undefined } | { readonly issues: readonly StandardIssue[] };

/** JSON Schema dialects `toJsonSchema` can produce: `draft-2020-12` and `draft-07`; others throw. */
export type JsonSchemaTarget = "draft-2020-12" | "draft-07" | "openapi-3.0" | ({} & string);

/** Options for `toJsonSchema` and `~standard.jsonSchema`. */
export interface JsonSchemaOptions {
  readonly target: JsonSchemaTarget,
  readonly libraryOptions?: Record<string, unknown> | undefined
}

/** `StandardSchemaV1.Props & StandardJSONSchemaV1.Props`. */
export interface StandardProps<Input = unknown, Output = Input> {
  readonly version: 1,
  readonly vendor: string,
  readonly types?: StandardTypes<Input, Output> | undefined,
  readonly validate: (value: unknown, options?: { readonly libraryOptions?: Record<string, unknown> | undefined }) => StandardResult<Output>,
  readonly jsonSchema: {
    readonly input: (options: JsonSchemaOptions) => Record<string, unknown>,
    readonly output: (options: JsonSchemaOptions) => Record<string, unknown>
  }
}

const TARGETS: Record<string, string> = {
  "draft-2020-12": "https://json-schema.org/draft/2020-12/schema",
  "draft-07": "http://json-schema.org/draft-07/schema#"
};

/**
 * The stored shape as JSON Schema: what an editor or agent writes, not the query
 * result (assets resolved to URLs). References and assets are described by their
 * IDs; whether they exist is the engine's check, as with `validate`.
 */
export function toJsonSchema(schema: AnySchema, options: JsonSchemaOptions = { target: "draft-2020-12" }): Record<string, unknown> {
  const $schema = TARGETS[options.target];
  if(!$schema) throw new Error(`vibe-cms: can't produce JSON Schema for target "${options.target}"`);
  return { $schema, ...convert(schema) };
}

function annotate(schema: AnySchema, json: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(schema.label ? { title: schema.label } : {}),
    ...(schema.description ? { description: schema.description } : {}),
    ...json,
    ...(schema.readOnly ? { readOnly: true } : {})
  };
}

function convert(schema: AnySchema): Record<string, unknown> {
  switch(schema.type) {
    case "optional":
      return convert((schema as OptionalSchema).inner);
    case "text": {
      const s = schema as TextSchema;
      const pattern = s.pattern ?? (s.format && s.format !== "email" ? formats[s.format]![0].source : undefined);
      return annotate(s, {
        type: "string",
        ...(s.format === "email" ? { format: "email" } : {}),
        ...(pattern ? { pattern } : {}),
        ...(s.min !== undefined ? { minLength: s.min } : {}),
        ...(s.max !== undefined ? { maxLength: s.max } : {})
      });
    }
    case "number": {
      const s = schema as NumberSchema;
      return annotate(s, {
        type: s.integer ? "integer" : "number",
        ...(s.min !== undefined ? { minimum: s.min } : {}),
        ...(s.max !== undefined ? { maximum: s.max } : {})
      });
    }
    case "boolean":
      return annotate(schema, { type: "boolean" });
    case "date":
      return annotate(schema, { type: "string", format: (schema as DateSchema).time ? "date-time" : "date" });
    case "literal":
      return annotate(schema, { const: (schema as LiteralSchema).value });
    case "enum":
      return annotate(schema, { type: "string", enum: [...(schema as EnumSchema).values] });
    case "array": {
      const s = schema as ArraySchema;
      return annotate(s, {
        type: "array",
        items: convert(s.item),
        ...(s.min !== undefined ? { minItems: s.min } : {}),
        ...(s.max !== undefined ? { maxItems: s.max } : {})
      });
    }
    case "object":
      return annotate(schema, shapeSchema((schema as ObjectSchema).shape));
    case "union":
      return annotate(schema, { anyOf: (schema as UnionSchema).options.map(convert) });
    case "ref": {
      const s = schema as RefSchema;
      if(s.to) return annotate(s, { type: "string", description: s.description ?? `ID of a document of type "${s.to}"` });
      return annotate(s, {
        type: "object",
        properties: { type: { type: "string", description: "Content type" }, id: { type: "string", description: "Document ID" } },
        required: ["type", "id"],
        additionalProperties: false
      });
    }
    case "asset": {
      const s = schema as AssetSchema;
      const fields = shapeSchema(s.fields);
      const accepts = s.accept?.length ? ` (${s.accept.join(", ")})` : "";
      return annotate(s, {
        ...fields,
        properties: { asset: { type: "string", description: `ID of an uploaded file${accepts}` }, ...fields.properties as object },
        required: ["asset", ...fields.required as string[]]
      });
    }
    default:
      throw new Error(`vibe-cms: no JSON Schema for field type "${schema.type}"`);
  }
}

function shapeSchema(shape: Shape) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for(const [key, field] of Object.entries(shape)) {
    properties[key] = convert(field);
    if(field.type !== "optional") required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * Adds `~standard` to a schema without making it part of the schema's data: it's
 * non-enumerable, so serializing the config (and its hash) is unchanged.
 */
export function withStandard<S extends AnySchema>(input: Omit<S, "~standard">): S {
  const schema = input as S;
  const props: StandardProps = {
    version: 1,
    vendor: "vibe-cms",
    validate: value => {
      const result = validate(schema, value);
      return result.issues.length ? { issues: result.issues } : { value: result.value };
    },
    jsonSchema: {
      input: options => toJsonSchema(schema, options),
      // `validate` returns the stored shape, so output and input are the same.
      output: options => toJsonSchema(schema, options)
    }
  };
  Object.defineProperty(schema, "~standard", { value: props, enumerable: false });
  return schema;
}
