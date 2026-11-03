import { TaggedError } from "better-result";
import { HttpError } from "../config.ts";

type Props = {
  message: string,
  /** Machine-readable context: validation `issues`, the `references` blocking a delete, a conflicting `updatedAt`. */
  details?: unknown
};

/** The input is malformed: missing fields, wrong types, an unknown locale. */
export class InvalidInput extends TaggedError("InvalidInput")<Props> {}
/** No session, or it expired. */
export class Unauthorized extends TaggedError("Unauthorized")<Props> {}
/** Signed in, but the user's roles don't allow it. */
export class Forbidden extends TaggedError("Forbidden")<Props> {}
export class NotFound extends TaggedError("NotFound")<Props> {}
/** It clashes with the current state: someone else's edit, references, a name that's taken. */
export class Conflict extends TaggedError("Conflict")<Props> {}
export class TooLarge extends TaggedError("TooLarge")<Props> {}
export class UnsupportedType extends TaggedError("UnsupportedType")<Props> {}
/** Well-formed but refused: content that fails validation, a plugin's veto, a file a field doesn't accept. */
export class Rejected extends TaggedError("Rejected")<Props> {}
/** The site can't do it as configured, e.g. uploads without an R2 binding. */
export class Unavailable extends TaggedError("Unavailable")<Props> {}

export type ActionError = InvalidInput | Unauthorized | Forbidden | NotFound | Conflict | TooLarge | UnsupportedType | Rejected | Unavailable;
export type ActionErrorTag = ActionError["_tag"];

const classes = { InvalidInput, Unauthorized, Forbidden, NotFound, Conflict, TooLarge, UnsupportedType, Rejected, Unavailable } as const;

/** Every surface's one translation table, here for HTTP. */
export function httpStatus(error: ActionError): number {
  return error.match({
    InvalidInput: () => 400,
    Unauthorized: () => 401,
    Forbidden: () => 403,
    NotFound: () => 404,
    Conflict: () => 409,
    TooLarge: () => 413,
    UnsupportedType: () => 415,
    Rejected: () => 422,
    Unavailable: () => 501
  });
}

/** The engine still throws `HttpError`; this is where its statuses become tags. */
export function fromHttpError(error: HttpError): ActionError {
  const props = { message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  switch(error.status) {
    case 401: return new Unauthorized(props);
    case 403: return new Forbidden(props);
    case 404: return new NotFound(props);
    case 409: return new Conflict(props);
    case 413: return new TooLarge(props);
    case 415: return new UnsupportedType(props);
    case 422: return new Rejected(props);
    case 501:
    case 502:
      return new Unavailable(props);
    default: return new InvalidInput(props);
  }
}

/** Rebuilds an error that crossed the wire as `{ tag, error, details }`. */
export function errorFromJson(body: { tag?: string, error?: string, details?: unknown }, status: number): ActionError {
  const props = { message: body.error ?? `Request failed (${status})`, ...(body.details === undefined ? {} : { details: body.details }) };
  const tagged = body.tag && body.tag in classes ? classes[body.tag as ActionErrorTag] : undefined;
  if(tagged) return new tagged(props);
  // No tag: the platform answered, not the CMS (an exception, a rate limit, a gateway). Worth retrying.
  if(status >= 500 || status === 429) return new Unavailable({ message: props.message, details: { status, retry: true } });
  return fromHttpError(new HttpError(status, props.message, props.details));
}

export function errorJson(error: ActionError) {
  return { error: error.message, tag: error._tag, ...(error.details === undefined ? {} : { details: error.details }) };
}
