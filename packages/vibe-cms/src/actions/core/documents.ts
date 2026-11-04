import { z } from "zod";
import type { Order } from "../../query/index.ts";
import { base, router } from "../define.ts";
import { limit, offset, type } from "./fields.ts";

const id = z.string().describe("Document ID");
const locale = z.string().optional().describe("Language code; the site's default language when omitted");
const data = z.record(z.string(), z.unknown()).describe("The document's fields. `schema.get` describes them for each content type");

const documentsList = base({
  summary: "List documents",
  description: "Documents of one type, drafts included, newest first unless sorted. `search` is full-text (each word matches as a prefix); with it, `total` counts matches, `all` counts the type, and `excerpts` maps document IDs to where the body matched.",
  readOnly: true
})
  .input(z.object({
    type,
    locale,
    search: z.string().optional(),
    limit,
    offset,
    sort: z.string().optional().describe("Field to sort by; prefix with - for descending, e.g. -publishedAt")
  }))
  .handler(({ context: { engine }, input }) => {
    const orderBy: Order[] | undefined = input.sort
      ? [{ path: [input.sort.replace(/^-/, "")], dir: input.sort.startsWith("-") ? "desc" : "asc" }]
      : undefined;
    return engine.listDocuments(input.type, { locale: input.locale, search: input.search, limit: input.limit ?? 50, offset: input.offset ?? 0, orderBy });
  });

const documentsSearch = base({
  summary: "Search documents",
  description: "Full-text search across every content type you can read, drafts included, best matches first. Words match as prefixes; titles rank above body text.",
  readOnly: true
})
  .input(z.object({
    query: z.string().min(1).max(200),
    locale,
    limit: z.number().int().min(1).max(50).optional()
  }))
  .handler(({ context: { engine }, input }) => engine.searchDocuments(input));

const documentsGet = base({
  summary: "Get a document",
  description: "A document's draft and published copies in one language, with its status, other languages and pending schedules. Pass `updatedAt` back as `baseUpdatedAt` when updating.",
  readOnly: true
})
  .input(z.object({
    type,
    id,
    locale
  }))
  .handler(({ context: { engine }, input }) => engine.getDocument(input.type, input.id, input.locale));

const documentsCreate = base({
  summary: "Create a document",
  description: "Saves a new draft. Drafts save even when invalid and the response lists the `issues`; `publish: true` publishes it too, which needs it to be valid."
})
  .input(z.object({
    type,
    id: z.string().optional().describe("A chosen ID; generated when omitted"),
    locale,
    data,
    publish: z.boolean().optional()
  }))
  .handler(({ context: { engine }, input }) => engine.save(input));

const documentsUpdate = base({
  summary: "Update a document",
  description: "Replaces the draft's fields; the published copy changes only when published. Also creates a missing translation.",
  idempotent: true
})
  .input(z.object({
    type,
    id,
    locale,
    data,
    baseUpdatedAt: z.number().optional().describe("The `updatedAt` you read. If someone saved since, this fails with CONFLICT instead of overwriting"),
    publish: z.boolean().optional()
  }))
  .handler(({ context: { engine }, input }) => engine.save(input));

const documentsDelete = base({
  summary: "Delete a document",
  description: "Moves the document, or with a non-default `locale` just that translation, to the trash. Fails with CONFLICT while other documents reference it, unless `force`."
})
  .input(z.object({
    type,
    id,
    locale,
    force: z.boolean().optional()
  }))
  .handler(({ context: { engine }, input }) => engine.delete(input.type, input.id, { force: input.force, locale: input.locale }));

const documentsPublish = base({
  summary: "Publish a document",
  description: "Makes the draft live and records a version. Fails with UNPROCESSABLE_CONTENT and the `issues` when the draft isn't valid.",
  idempotent: true
})
  .input(z.object({
    type,
    id,
    locale
  }))
  .handler(({ context: { engine }, input }) => engine.publish(input.type, input.id, input.locale));

const documentsUnpublish = base({
  summary: "Unpublish a document",
  description: "Takes the document off the site. The draft and its history stay.",
  idempotent: true
})
  .input(z.object({
    type,
    id,
    locale
  }))
  .handler(({ context: { engine }, input }) => engine.unpublish(input.type, input.id, input.locale));

const documentsReferences = base({
  summary: "List references to a document",
  description: "Documents that point at this one. Check before deleting.",
  readOnly: true
})
  .input(z.object({
    type,
    id
  }))
  .handler(async ({ context: { engine }, input }) => ({ references: await engine.incomingReferences(input.id) }));

const documentsVersions = base({
  summary: "List versions",
  description: "Published versions of a document in one language, newest first.",
  readOnly: true
})
  .input(z.object({
    type,
    id,
    locale
  }))
  .handler(async ({ context: { engine }, input }) => ({ versions: await engine.versions(input.type, input.id, input.locale) }));

const documentsVersion = base({
  summary: "Get a version",
  description: "One published version's fields.",
  readOnly: true
})
  .input(z.object({
    type,
    id,
    locale,
    ver: z.number().int().min(1)
  }))
  .handler(({ context: { engine }, input }) => engine.version(input.type, input.id, input.locale, input.ver));

const documentsRestoreVersion = base({
  summary: "Restore a version",
  description: "Copies a version into the draft. It isn't live until published."
})
  .input(z.object({
    type,
    id,
    locale,
    ver: z.number().int().min(1)
  }))
  .handler(({ context: { engine }, input }) => engine.restore(input.type, input.id, input.locale, input.ver));

const scheduleAction = z.enum(["publish", "unpublish"]);

const documentsSchedule = base({
  summary: "Schedule publishing",
  description: "Publishes or unpublishes at a time. Scheduling a publish snapshots the draft now, so later edits aren't published by surprise.",
  idempotent: true
})
  .input(z.object({
    type,
    id,
    locale,
    action: scheduleAction,
    runAt: z.string().describe("ISO 8601 date and time")
  }))
  .handler(({ context: { engine }, input }) => engine.schedule(input.type, input.id, input.locale, input.action, input.runAt));

const documentsUnschedule = base({
  summary: "Cancel a schedule",
  description: "Cancels a pending scheduled publish or unpublish.",
  idempotent: true
})
  .input(z.object({
    type,
    id,
    locale,
    action: scheduleAction.default("publish")
  }))
  .handler(({ context: { engine }, input }) => engine.cancelSchedule(input.type, input.id, input.locale, input.action));

export const documents = router({
  list: documentsList,
  search: documentsSearch,
  get: documentsGet,
  create: documentsCreate,
  update: documentsUpdate,
  delete: documentsDelete,
  publish: documentsPublish,
  unpublish: documentsUnpublish,
  references: documentsReferences,
  versions: documentsVersions,
  version: documentsVersion,
  restoreVersion: documentsRestoreVersion,
  schedule: documentsSchedule,
  unschedule: documentsUnschedule
});
