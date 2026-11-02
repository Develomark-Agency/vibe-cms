import { Result } from "better-result";
import type { z } from "zod";
import { HttpError } from "../config.ts";
import type { Engine } from "../handler/engine.ts";
import { fromHttpError, InvalidInput, type ActionError } from "./errors.ts";

/** What an action runs against: the engine for this request's session. */
export interface ActionContext {
  engine: Engine,
  /** The request's hostname, the site's name when neither the code nor an editor set one. */
  host: string
}

/** Hints for surfaces that show or gate actions, matching MCP's tool annotations. */
export interface ActionAnnotations {
  /** Reads only. */
  readOnly?: boolean,
  /** May lose data, e.g. purging the trash. Deleting into the trash isn't destructive. */
  destructive?: boolean,
  /** Repeating it with the same input changes nothing more. */
  idempotent?: boolean
}

/** A named capability with a Zod input, run by every surface (REST, MCP, CLI, the editor). */
export interface Action<N extends string = string, I extends z.ZodType = z.ZodType, O = unknown> {
  /** `group.verb`, e.g. `documents.list`. Surfaces derive their own names from it. */
  name: N,
  title: string,
  description: string,
  input: I,
  annotations: ActionAnnotations,
  run(ctx: ActionContext, input: z.output<I>): Promise<Result<O, ActionError>>
}

/** Any action. */
export type AnyAction = Action<string, z.ZodType, any>;
/** An action's input, as callers write it. */
export type ActionInput<A extends AnyAction> = z.input<A["input"]>;
/** What an action resolves to. */
export type ActionOutput<A extends AnyAction> = A extends Action<any, any, infer O> ? O : never;

/** Declares an action; the identity function, for inference. */
export function defineAction<const N extends string, I extends z.ZodType, O>(action: Action<N, I, O>): Action<N, I, O> {
  return action;
}

/** Calls into the engine, which still throws `HttpError`, and turns those into tagged errors. Anything else is a bug and keeps throwing. */
export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T, ActionError>> {
  try {
    return Result.ok(await fn());
  } catch (error) {
    if(error instanceof HttpError) return Result.err(fromHttpError(error));
    throw error;
  }
}

/** The one entry point every surface uses: validate the input, then run. */
export async function runAction<A extends AnyAction>(action: A, ctx: ActionContext, input: unknown): Promise<Result<ActionOutput<A>, ActionError>> {
  const parsed = action.input.safeParse(input ?? {});
  if(!parsed.success) {
    const issues = parsed.error.issues.map(issue => ({ path: issue.path.map(key => (typeof key === "symbol" ? String(key) : key)), message: issue.message }));
    const first = issues[0]!;
    const where = first.path.length ? `${first.path.join(".")}: ` : "";
    return Result.err(new InvalidInput({ message: `${where}${first.message}`, details: { issues } }));
  }
  return action.run(ctx, parsed.data);
}
