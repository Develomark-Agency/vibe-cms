import { getOpenAPIMeta, openapi } from "@orpc/openapi";
import { call, defineMeta, ORPCError, os, walkProcedureContractsSync, type AnyProcedure, type AnyRouter, type ErrorMapItem, type RouterClient } from "@orpc/server";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { HttpError } from "../config.ts";
import type { Permit } from "../handler/auth.ts";
import type { Engine } from "../handler/engine.ts";
import { codeForStatus, type ActionError, type ActionErrorCode } from "./errors.ts";
import type { ActionInput } from "./inputs.ts";

/** What an action runs against: the engine for this request's session. */
export interface ActionContext {
  engine: Engine
}

/** Hints for surfaces that show or gate actions, matching MCP's tool annotations. */
export interface ActionAnnotations {
  /** Reads only. */
  readOnly?: boolean,
  /** May lose data, e.g. purging the trash. Deleting into the trash isn't destructive. */
  destructive?: boolean,
  /** Repeating it with the same input changes nothing more. */
  idempotent?: boolean,
  /**
   * Whether agents get it as an MCP tool. Built-in actions are tools unless `false`; a plugin's
   * actions only when `true`. Every action stays reachable by name over REST and the CLI.
   */
  mcp?: boolean,
  /** A plugin action's permission, checked before it runs, on top of needing a signed-in user: `{ action: "write", scope: "site" }`. */
  permit?: Permit
}

const [annotationsMeta, getAnnotations] = defineMeta<"vibe/annotations", ActionAnnotations>("vibe/annotations", (incoming, current) => ({ ...current, ...incoming }));

/** An action's {@link ActionAnnotations}, as declared with {@link base}. */
export { getAnnotations };

const path = z.array(z.union([z.string(), z.number()]));
const issues = z.array(z.object({ path, message: z.string() }));

/**
 * The errors every action can fail with, and the `data` each carries (`undefined` when it carries none).
 * oRPC only treats an error as declared (`isDefinedError`) when its data fits, so these describe exactly
 * what the engine throws. Codes: `vibe-cms docs agents`.
 */
export const errorMap = {
  /** `issues`: the input that failed its schema, or a value the engine refused (a row with the wrong type). */
  BAD_REQUEST: { data: z.object({ issues }).optional() },
  UNAUTHORIZED: {},
  FORBIDDEN: {},
  NOT_FOUND: {},
  CONFLICT: {
    data: z.object({
      /** Someone saved since `baseUpdatedAt`: when, and by whom. */
      updatedAt: z.number().optional(),
      updatedBy: z.string().nullable().optional(),
      /** Documents that still point at the one being deleted. */
      references: z.array(z.object({ id: z.string(), type: z.string(), locale: z.string() })).optional(),
      /** Stored values that no longer fit their field (a schema change). */
      mismatches: z.array(z.object({ type: z.string(), id: z.string(), locale: z.string(), path, expected: z.string(), found: z.string() })).optional(),
      /** The unfinished restore in the way. */
      restoreId: z.string().optional()
    }).optional()
  },
  PAYLOAD_TOO_LARGE: {},
  UNSUPPORTED_MEDIA_TYPE: {},
  UNPROCESSABLE_CONTENT: {
    data: z.object({
      /** Content that fails validation. */
      issues: issues.optional(),
      /** Why a snapshot can't be restored here, and what to know anyway. */
      problems: z.array(z.string()).optional(),
      warnings: z.array(z.string()).optional()
    }).optional()
  },
  NOT_IMPLEMENTED: {},
  BAD_GATEWAY: {},
  SERVICE_UNAVAILABLE: { data: z.object({ status: z.number().optional(), retry: z.boolean().optional() }).optional() }
} satisfies { [K in ActionErrorCode]: ErrorMapItem };

/** The engine still throws `HttpError`; this is where its statuses become codes. Its `details` become `data`. */
export function fromHttpError(error: HttpError): ActionError {
  return new ORPCError(codeForStatus(error.status), { message: error.message, ...(error.details === undefined ? {} : { data: error.details }) }) as ActionError;
}

const builder = os
  .$context<ActionContext>()
  .errors(errorMap)
  .use(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if(error instanceof HttpError) throw fromHttpError(error);
      // The first failed input check, as one readable line: `data.title: Invalid input`.
      if(error instanceof ORPCError && error.code === "BAD_REQUEST" && (error.data as { issues?: unknown } | undefined)?.issues) {
        const raw = (error.data as { issues: Array<{ message: string, path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> }).issues;
        const issues = raw.map(issue => ({ path: (issue.path ?? []).map(step => { const key = typeof step === "object" ? step.key : step; return typeof key === "number" ? key : String(key); }), message: issue.message }));
        const first = issues[0];
        throw new ORPCError("BAD_REQUEST", { message: first ? `${first.path.length ? `${first.path.join(".")}: ` : ""}${first.message}` : error.message, data: { issues } });
      }
      throw error;
    }
  });

/** What every action declares: `summary` and `description` (shown by MCP, the CLI and the actions listing) and its {@link ActionAnnotations}. */
export interface ActionMeta extends ActionAnnotations {
  summary: string,
  description: string
}

/**
 * Starts an action: `base({ summary, description, readOnly: true }).input(…).handler(…)`. What it
 * builds on has the engine as context, the shared errors, and `HttpError`s from the engine turned into
 * them. Chain `.meta(…)` for anything else.
 */
export function base({ summary, description, ...annotations }: ActionMeta) {
  return builder.meta(openapi({ summary, description }), annotationsMeta(annotations));
}

/** What a plugin's `actions` holds for each action: made by {@link defineAction}. */
export type ActionDefinition = AnyProcedure;

/** What a handler is called with: the input, parsed by the schema, and the signed-in user's view of the site. */
export type ActionHandlerArgs<S extends ActionInput | undefined> = S extends ActionInput
  ? { input: StandardSchemaV1.InferOutput<S>, engine: Engine }
  : { engine: Engine };

/** What {@link defineAction} takes: the metadata every action declares, its input schema and its handler. */
export interface ActionConfig<S extends ActionInput | undefined> extends ActionMeta {
  /** Any schema with Standard Schema and Standard JSON Schema, such as zod 4's. Left out, the action takes no input. */
  input?: S,
  handler: (args: ActionHandlerArgs<S>) => unknown
}

/**
 * Defines an action for a plugin's `actions`. See `vibe-cms docs plugin-actions`.
 *
 * ```ts
 * defineAction({
 *   summary: "Longest posts",
 *   description: "The published posts with the most words.",
 *   readOnly: true,
 *   mcp: true,
 *   input: z.object({ limit: z.number().default(5) }),
 *   handler: ({ input }) => …
 * })
 * ```
 */
export function defineAction<S extends ActionInput | undefined = undefined>(config: ActionConfig<S>): ActionDefinition {
  const { input, handler, ...meta } = config;
  const builder = base(meta);
  const withInput = (input ? builder.input(input as never) : builder) as unknown as { handler(run: (args: { input: unknown, context: ActionContext }) => unknown): ActionDefinition };
  return withInput.handler(({ input: parsed, context }) => handler({ input: parsed, engine: context.engine } as ActionHandlerArgs<S>));
}

/** Groups actions into a router: `router({ list, get })`. Plain objects work too, but this checks that everything in it is an action or another router. */
export function router<T extends AnyRouter>(routes: T) {
  return os.$context<ActionContext>().router(routes);
}

/** Any router of actions: procedures grouped in plain objects. */
export type ActionRouter = AnyRouter;

/** One action found in a router: its dotted name (`documents.list`), metadata and input schema. */
export interface ActionEntry {
  /** The path joined with dots, e.g. `documents.list`. Surfaces derive their own names from it. */
  name: string,
  path: string[],
  title: string,
  description: string,
  annotations: ActionAnnotations,
  input: ActionInput,
  procedure: AnyProcedure,
  /** The plugin that provides it; absent for built-in actions. */
  plugin?: string,
  /** Whether it's offered as an MCP tool: see {@link ActionAnnotations.mcp}. */
  mcp: boolean
}

/** An action's input schema (an empty object when it takes none). */
export function inputSchemaOf(procedure: AnyProcedure): ActionInput {
  const schemas = procedure["~orpc"].inputSchemas as unknown;
  return ((Array.isArray(schemas) ? schemas[0] : schemas) ?? z.object({})) as ActionInput;
}

/** What an action takes, as callers write it. */
export type ActionInputOf<P extends AnyProcedure> = NonNullable<Parameters<RouterClient<P>>[0]>;

/** Every action in a router, in declaration order. Surfaces (REST, MCP, CLI) are generated from this. `plugin` marks them as that plugin's. */
export function listActions(router: ActionRouter, plugin?: string): ActionEntry[] {
  const entries: ActionEntry[] = [];
  walkProcedureContractsSync(router, (contract, path) => {
    const procedure = contract as AnyProcedure;
    const name = path.join(".");
    const docs = getOpenAPIMeta(procedure);
    // Surfaces show these (MCP tool lists, CLI help, the actions listing), so an action can't go without.
    if(!docs?.summary || !docs.description) throw new Error(`Action ${name} needs .meta(openapi({ summary, description }))`);
    const annotations = getAnnotations(procedure) ?? {};
    entries.push({
      name,
      path,
      title: docs.summary,
      description: docs.description,
      annotations,
      input: inputSchemaOf(procedure),
      procedure,
      ...(plugin ? { plugin } : {}),
      mcp: plugin ? annotations.mcp === true : annotations.mcp !== false
    });
  });
  return entries;
}

/** The same, by name. */
export function indexActions(router: ActionRouter): Map<string, ActionEntry> {
  return new Map(listActions(router).map(entry => [entry.name, entry]));
}

/**
 * Runs an action for a caller: a plugin's needs a signed-in user the connection allows (read-only
 * connections only run `readOnly` actions) and its `permit`, since nothing in its handler checks them.
 * Built-in actions check through the engine. Failures are the shared {@link ActionError}s.
 */
export async function runAction(entry: ActionEntry, ctx: ActionContext, input: unknown): Promise<unknown> {
  try {
    if(entry.plugin) ctx.engine.authorize(entry.annotations, entry.annotations.permit);
    return await call(entry.procedure, input, { context: ctx });
  } catch (error) {
    if(error instanceof HttpError) {
      // Declared, as the failures inside an action are, so surfaces report it as the action's refusal.
      // oRPC marks `defined` itself for what a procedure throws; this one is thrown before it runs.
      throw Object.assign(fromHttpError(error), { defined: true });
    }
    throw error;
  }
}
