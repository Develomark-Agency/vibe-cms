import { z } from "zod";
import type { Order } from "../../query/index.ts";
import { base, router } from "../define.ts";
import { limit, offset, type } from "./fields.ts";

const id = z.string().describe("Document ID");
const locale = z.string().optional().describe("Language code; the site's default language when omitted");
const data = z.record(z.string(), z.unknown()).describe("The document's fields. `schema.get` describes them for each content type");

const documentsList = base({
  summary: "List documents",
  description: "Documents of one type, unpublished ones included, as you'd edit them (your changes, else live), newest first unless sorted. `search` is full-text (each word matches as a prefix); with it, `total` counts matches, `all` counts the type, and `excerpts` maps document IDs to where the body matched.",
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
  description: "Full-text search across every content type you can read, unpublished changes included, best matches first. Words match as prefixes; titles rank above body text.",
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
  description: "A document in one language: `draft` is your working copy (your unpublished changes, else live), `published` the live copy, `pending` who else has unpublished changes, plus status, other languages and schedules. Pass `updatedAt` back as `baseUpdatedAt` and `baseVer` as `baseVer` when updating.",
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
  description: "Saves a new document as your unpublished changes. They save even when invalid and the response lists the `issues`; `publish: true` publishes it too, which needs it to be valid."
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
  description: "Replaces the fields of your copy: your branch of the document, a candidate for publishing. Other people's changes and the live copy aren't touched until someone publishes. Also creates a missing translation.",
  idempotent: true
})
  .input(z.object({
    type,
    id,
    locale,
    data,
    baseUpdatedAt: z.number().optional().describe("The `updatedAt` you read. If you saved this document elsewhere since (another tab, another agent as you), this fails with CONFLICT instead of overwriting"),
    baseVer: z.number().int().nullable().optional().describe("The `baseVer` you read: the published version your data started from, so changes published since aren't taken for yours"),
    publish: z.boolean().optional().describe("Publish your changes too")
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
    force: z.boolean().optional(),
    redirectTo: z.string().optional().describe("Where visitors to the page go instead: a path like /news or a full URL. Adds a redirect from the page's address, which restoring the document removes. Ignored for a translation")
  }))
  .handler(({ context: { engine }, input }) => engine.delete(input.type, input.id, { force: input.force, locale: input.locale, redirectTo: input.redirectTo }));

/** Which unpublished changes to publish, for `documents.publish` and `documents.schedule`. */
const selection = {
  branches: z.array(z.string()).optional().describe("Owners whose changes to publish; everyone's when omitted"),
  skip: z.array(z.object({ owner: z.string(), path: z.string() })).optional().describe("Changes to leave unpublished, by owner and `path`"),
  resolve: z.array(z.object({
    group: z.string().describe("The conflict's `group`"),
    use: z.string().optional().describe("Whose change to keep: an owner, or `live` to keep what's live"),
    value: z.unknown().optional().describe("A value to publish instead of either side")
  })).optional()
};

const documentsPublish = base({
  summary: "Publish a document",
  description: "Merges unpublished changes into a new live version and records it: everyone's by default, or the `branches` (owners) you name, minus the changes in `skip`. Fails with CONFLICT and the `conflicts` when two people changed the same thing differently, or someone changed what's since been published; settle each by its `group` in `resolve`. `documents.changes` lists the changes and groups. Fails with UNPROCESSABLE_CONTENT and the `issues` when the result isn't valid.",
  idempotent: true
})
  .input(z.object({
    type,
    id,
    locale,
    redirect: z.boolean().optional().describe("When publishing changes the page's address, also redirect the old address to the new one (`redirects.suggest` shows it)"),
    ...selection
  }))
  .handler(({ context: { engine }, input }) => engine.publish(input.type, input.id, input.locale, { redirect: input.redirect, branches: input.branches, skip: input.skip, resolve: input.resolve }));

const documentsChanges = base({
  summary: "List unpublished changes",
  description: "Everyone's unpublished changes to a document, by person: each change's `path`, `before` and `after`, and its `status` against live: `clean`, `stale` (live changed since) or `conflict` (someone else changed it too). Changes with the same `group` are settled together when publishing.",
  readOnly: true
})
  .input(z.object({
    type,
    id,
    locale
  }))
  .handler(({ context: { engine }, input }) => engine.changes(input.type, input.id, input.locale));

const documentsPending = base({
  summary: "List documents awaiting publishing",
  description: "Every document with unpublished changes, across the content types you can read, most recently changed first: who has changes, and whether you may publish them. Use it to find what needs reviewing.",
  readOnly: true
})
  .input(z.object({ limit: z.number().int().min(1).max(200).optional() }))
  .handler(({ context: { engine }, input }) => engine.pendingDocuments(input));

const documentsDiscardChanges = base({
  summary: "Discard unpublished changes",
  description: "Throws away one person's unpublished changes: yours, or with `owner` someone else's, which needs permission to publish. Published versions stay in the history.",
  idempotent: true
})
  .input(z.object({
    type,
    id,
    locale,
    owner: z.string().optional().describe("Whose changes; yours when omitted")
  }))
  .handler(({ context: { engine }, input }) => engine.discardBranch(input.type, input.id, input.locale, input.owner));

const documentsUnpublish = base({
  summary: "Unpublish a document",
  description: "Takes the document off the site. Unpublished changes and history stay.",
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
  description: "Copies a version into your unpublished changes. It isn't live until published."
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
  description: "Publishes or unpublishes at a time. Scheduling a publish merges unpublished changes now (everyone's, or a selection as `documents.publish` takes it), so later edits aren't published by surprise. Fails with CONFLICT while selected changes conflict.",
  idempotent: true
})
  .input(z.object({
    type,
    id,
    locale,
    action: scheduleAction,
    runAt: z.string().describe("ISO 8601 date and time"),
    redirect: z.boolean().optional().describe("For a scheduled publish: when it runs and changes the page's address, also redirect the old address to the new one. Needs permission to manage redirects. The addresses are worked out when it runs"),
    ...selection
  }))
  .handler(({ context: { engine }, input }) => engine.schedule(input.type, input.id, input.locale, input.action, input.runAt, { redirect: input.redirect, branches: input.branches, skip: input.skip, resolve: input.resolve }));

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
  changes: documentsChanges,
  pending: documentsPending,
  discardChanges: documentsDiscardChanges,
  unpublish: documentsUnpublish,
  references: documentsReferences,
  versions: documentsVersions,
  version: documentsVersion,
  restoreVersion: documentsRestoreVersion,
  schedule: documentsSchedule,
  unschedule: documentsUnschedule
});
