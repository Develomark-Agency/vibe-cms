import type { ORPCErrorFromErrorMap } from "@orpc/server";
import type { errorMap } from "./define.ts";
import { COMMON_ERROR_STATUS_MAP, createORPCErrorFromJson, isDefinedError, ORPCError } from "@orpc/client";

/**
 * The errors every action can fail with, as oRPC error codes (`base` declares them, so typed clients
 * know them; `data` carries context: validation `issues`, the `references` blocking a delete, a
 * conflicting `updatedAt`). What each means here:
 *
 * - `BAD_REQUEST`: malformed input: missing fields, wrong types, an unknown locale.
 * - `UNAUTHORIZED`: no session, or it expired.
 * - `FORBIDDEN`: signed in, but the user's roles don't allow it.
 * - `CONFLICT`: it clashes with the current state: someone else's edit, references, a taken name.
 * - `UNPROCESSABLE_CONTENT`: well-formed but refused: invalid content, a plugin's veto, a file a field doesn't accept.
 * - `NOT_IMPLEMENTED`: the site can't do it as configured, e.g. uploads without an R2 binding.
 */
export const ERROR_CODES = [
  "BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE", "UNPROCESSABLE_CONTENT", "NOT_IMPLEMENTED", "BAD_GATEWAY", "SERVICE_UNAVAILABLE"
] as const;

export type ActionErrorCode = (typeof ERROR_CODES)[number];

/**
 * An action's declared failure, as a union by code: `error.code === "CONFLICT"` narrows `error.data` to
 * what a conflict carries (`updatedAt`, `references`, …). Declared in `errorMap` (`define.ts`).
 */
export type ActionError = ORPCErrorFromErrorMap<typeof errorMap>;

const byStatus: Record<number, ActionErrorCode> = {
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE_CONTENT",
  501: "NOT_IMPLEMENTED",
  502: "BAD_GATEWAY"
};

/** The code for an HTTP status; anything unlisted is the caller's mistake. */
export function codeForStatus(status: number): ActionErrorCode {
  return byStatus[status] ?? "BAD_REQUEST";
}

/** The HTTP status for an error code. */
export function statusForCode(code: string): number {
  return (COMMON_ERROR_STATUS_MAP as Record<string, number>)[code] ?? 500;
}

/**
 * Whether a failure is one of the actions' declared errors (oRPC's `isDefinedError`): the action ran and
 * refused, as opposed to a bug or a platform failure. `isDefinedError` itself narrows `unknown` to `never`,
 * so use this on a `catch`'s `error`; with a typed client, `safe(client.documents.get(…))` narrows to the
 * exact codes and data.
 */
export function isActionError(error: unknown): error is ActionError {
  return error instanceof ORPCError && isDefinedError(error);
}

/**
 * The JSON every surface reports an error as: `{ error, code, defined, data? }`, oRPC's error JSON with
 * the message also under `error`. `defined` says the action declared this error.
 */
export function errorBody(error: { code: string, message: string, data?: unknown, defined?: boolean }) {
  return { error: error.message, code: error.code, defined: error.defined === true, ...(error.data === undefined ? {} : { data: error.data }) };
}

/** Rebuilds an error that crossed the wire as `{ error, code, defined, data }`; it is `defined` only if the server said so. */
export function errorFromBody(body: { code?: string, error?: string, data?: unknown, defined?: boolean }, status: number): ORPCError<string, unknown> {
  const message = body.error ?? `Request failed (${status})`;
  if(body.code && (ERROR_CODES as readonly string[]).includes(body.code)) return createORPCErrorFromJson({ defined: body.defined === true, code: body.code, message, data: body.data });
  // No code: the platform answered, not the CMS (an exception, a rate limit, a gateway). Worth retrying.
  if(status >= 500 || status === 429) return new ORPCError("SERVICE_UNAVAILABLE", { message, data: { status, retry: true } });
  return new ORPCError(codeForStatus(status), { message, ...(body.data === undefined ? {} : { data: body.data }) });
}

/** Whether a failure is the platform's, not the CMS's: worth trying again. */
export function isRetryable(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "SERVICE_UNAVAILABLE" && (error.data as { retry?: boolean } | undefined)?.retry === true;
}

export { ORPCError };
