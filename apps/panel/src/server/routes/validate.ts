import { validator } from "hono/validator";
import { PanelError, type BackupPolicy } from "vibe-cms/panel";

/** A JSON object body, checked field by field, so routes (and `hc` clients of them) know its type. */
function object(value: unknown): Record<string, unknown> {
  if(typeof value !== "object" || value === null || Array.isArray(value)) throw new PanelError(400, "Expected a JSON object body");
  return value as Record<string, unknown>;
}

function text(input: Record<string, unknown>, field: string): string {
  if(typeof input[field] !== "string") throw new PanelError(400, `Expected ${field}`);
  return input[field];
}

/** `{ url }`: the address of a site to add. */
export const siteBody = validator("json", value => {
  const input = object(value);
  const templateId = input.templateId;
  if(templateId !== undefined && templateId !== null && typeof templateId !== "string") throw new PanelError(400, "Expected templateId");
  // Undefined: the default template. Null: no roles.
  return { url: text(input, "url"), templateId: templateId as string | null | undefined };
});

/** `{ snapshot }`: the snapshot to restore. */
export const restoreBody = validator("json", value => ({ snapshot: text(object(value), "snapshot") }));

/** `{ policy }`: sanitized by the route, which knows what a policy may hold. */
export const policyBody = validator("json", value => ({ policy: object(value).policy as BackupPolicy }));

/** `{ policy }`, where `null` goes back to the panel's defaults. */
export const sitePolicyBody = validator("json", value => ({ policy: (object(value).policy ?? null) as BackupPolicy | null }));
