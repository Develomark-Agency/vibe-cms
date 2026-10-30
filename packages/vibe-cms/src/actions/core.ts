import { Result } from "better-result";
import { z } from "zod";
import { getSchema } from "../config.ts";
import type { Order } from "../query/index.ts";
import { attempt, defineAction } from "./define.ts";

const type = z.string().describe("Content type, e.g. \"post\". `schema.list` lists them");
const id = z.string().describe("Document ID");
const locale = z.string().optional().describe("Language code; the site's default language when omitted");
const assetId = z.string().describe("Asset ID");
const trashId = z.string().describe("Trash item ID, from `trash.list`");
const limit = z.number().int().min(1).max(200).optional();
const offset = z.number().int().min(0).optional();
const data = z.record(z.string(), z.unknown()).describe("The document's fields. `schema.get` describes them for each content type");

// --- Schema --------------------------------------------------------------------

const schemaList = defineAction({
  name: "schema.list",
  title: "List content types",
  description: "The site's content types and languages. Call `schema.get` for a type's fields before writing documents.",
  input: z.object({}),
  annotations: { readOnly: true },
  run: async ({ engine }) => {
    const { config } = engine;
    return Result.ok({
      locales: config.locales,
      defaultLocale: config.defaultLocale,
      types: Object.keys(config.schemas).map(name => {
        const settings = config.collections?.[name];
        return { type: name, label: settings?.label ?? null, singleton: settings?.singleton ?? false };
      })
    });
  }
});

const schemaGet = defineAction({
  name: "schema.get",
  title: "Get a content type's fields",
  description: "JSON Schema for one content type's documents: the shape `data` must have when creating or updating them.",
  input: z.object({ type }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(async () => {
    getSchema(engine.config, input.type);
    return engine.config.schemas[input.type]!["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  })
});

// --- Documents -----------------------------------------------------------------

const documentsList = defineAction({
  name: "documents.list",
  title: "List documents",
  description: "Documents of one type, drafts included, newest first unless sorted. `search` matches indexed text.",
  input: z.object({
    type,
    locale,
    search: z.string().optional(),
    limit,
    offset,
    sort: z.string().optional().describe("Field to sort by; prefix with - for descending, e.g. -publishedAt")
  }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => {
    const orderBy: Order[] | undefined = input.sort
      ? [{ path: [input.sort.replace(/^-/, "")], dir: input.sort.startsWith("-") ? "desc" : "asc" }]
      : undefined;
    return attempt(() => engine.listDocuments(input.type, { locale: input.locale, search: input.search, limit: input.limit ?? 50, offset: input.offset ?? 0, orderBy }));
  }
});

const documentsGet = defineAction({
  name: "documents.get",
  title: "Get a document",
  description: "A document's draft and published copies in one language, with its status, other languages and pending schedules. Pass `updatedAt` back as `baseUpdatedAt` when updating.",
  input: z.object({ type, id, locale }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(() => engine.getDocument(input.type, input.id, input.locale))
});

const documentsCreate = defineAction({
  name: "documents.create",
  title: "Create a document",
  description: "Saves a new draft. Drafts save even when invalid and the response lists the `issues`; `publish: true` publishes it too, which needs it to be valid.",
  input: z.object({
    type,
    id: z.string().optional().describe("A chosen ID; generated when omitted"),
    locale,
    data,
    publish: z.boolean().optional()
  }),
  annotations: {},
  run: ({ engine }, input) => attempt(() => engine.save(input))
});

const documentsUpdate = defineAction({
  name: "documents.update",
  title: "Update a document",
  description: "Replaces the draft's fields; the published copy changes only when published. Also creates a missing translation.",
  input: z.object({
    type,
    id,
    locale,
    data,
    baseUpdatedAt: z.number().optional().describe("The `updatedAt` you read. If someone saved since, this fails with Conflict instead of overwriting"),
    publish: z.boolean().optional()
  }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => engine.save(input))
});

const documentsDelete = defineAction({
  name: "documents.delete",
  title: "Delete a document",
  description: "Moves the document, or with a non-default `locale` just that translation, to the trash. Fails with Conflict while other documents reference it, unless `force`.",
  input: z.object({ type, id, locale, force: z.boolean().optional() }),
  annotations: {},
  run: ({ engine }, input) => attempt(() => engine.delete(input.type, input.id, { force: input.force, locale: input.locale }))
});

const documentsPublish = defineAction({
  name: "documents.publish",
  title: "Publish a document",
  description: "Makes the draft live and records a version. Fails with Rejected and the `issues` when the draft isn't valid.",
  input: z.object({ type, id, locale }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => engine.publish(input.type, input.id, input.locale))
});

const documentsUnpublish = defineAction({
  name: "documents.unpublish",
  title: "Unpublish a document",
  description: "Takes the document off the site. The draft and its history stay.",
  input: z.object({ type, id, locale }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => engine.unpublish(input.type, input.id, input.locale))
});

const documentsReferences = defineAction({
  name: "documents.references",
  title: "List references to a document",
  description: "Documents that point at this one. Check before deleting.",
  input: z.object({ type, id }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(async () => ({ references: await engine.incomingReferences(input.id) }))
});

const documentsVersions = defineAction({
  name: "documents.versions",
  title: "List versions",
  description: "Published versions of a document in one language, newest first.",
  input: z.object({ type, id, locale }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(async () => ({ versions: await engine.versions(input.type, input.id, input.locale) }))
});

const documentsVersion = defineAction({
  name: "documents.version",
  title: "Get a version",
  description: "One published version's fields.",
  input: z.object({ type, id, locale, ver: z.number().int().min(1) }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(() => engine.version(input.type, input.id, input.locale, input.ver))
});

const documentsRestoreVersion = defineAction({
  name: "documents.restoreVersion",
  title: "Restore a version",
  description: "Copies a version into the draft. It isn't live until published.",
  input: z.object({ type, id, locale, ver: z.number().int().min(1) }),
  annotations: {},
  run: ({ engine }, input) => attempt(() => engine.restore(input.type, input.id, input.locale, input.ver))
});

const scheduleAction = z.enum(["publish", "unpublish"]);

const documentsSchedule = defineAction({
  name: "documents.schedule",
  title: "Schedule publishing",
  description: "Publishes or unpublishes at a time. Scheduling a publish snapshots the draft now, so later edits aren't published by surprise.",
  input: z.object({ type, id, locale, action: scheduleAction, runAt: z.string().describe("ISO 8601 date and time") }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => engine.schedule(input.type, input.id, input.locale, input.action, input.runAt))
});

const documentsUnschedule = defineAction({
  name: "documents.unschedule",
  title: "Cancel a schedule",
  description: "Cancels a pending scheduled publish or unpublish.",
  input: z.object({ type, id, locale, action: scheduleAction.default("publish") }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => engine.cancelSchedule(input.type, input.id, input.locale, input.action))
});

// --- Media ---------------------------------------------------------------------

const folder = z.string().describe("Folder path like posts/covers");

const assetsList = defineAction({
  name: "assets.list",
  title: "List files",
  description: "Files in the media library, newest first. `folder: \"\"` lists the root only; omit it for every folder.",
  input: z.object({
    folder: z.string().optional(),
    search: z.string().optional().describe("Matches file names"),
    accept: z.array(z.string()).optional().describe("MIME types, wildcards allowed, e.g. image/*"),
    limit,
    offset
  }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(() => engine.listAssets({ ...input, limit: input.limit ?? 60, offset: input.offset ?? 0 }))
});

const assetsGet = defineAction({
  name: "assets.get",
  title: "Get a file",
  description: "A file's details and the documents that use it.",
  input: z.object({ id: assetId }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(() => engine.getAsset(input.id))
});

const assetsUpload = defineAction({
  name: "assets.upload",
  title: "Upload a file",
  description: "Adds a file to the media library. Pass `type` and `field` to check it against that asset field (accepted types, size, image dimensions). Use the returned `id` as `{ asset: id }` in documents.",
  input: z.object({
    file: z.file(),
    folder: z.string().optional(),
    type: z.string().optional().describe("Content type whose field the file is for"),
    field: z.string().optional().describe("Dot path of that asset field, e.g. cover")
  }),
  annotations: {},
  run: ({ engine }, input) => attempt(() => engine.upload(input.file, { folder: input.folder || undefined, type: input.type || undefined, field: input.field || undefined }))
});

const assetsUpdate = defineAction({
  name: "assets.update",
  title: "Rename or move a file",
  description: "Changes a file's name or folder. `folder: null` moves it to the root.",
  input: z.object({ id: assetId, filename: z.string().optional(), folder: folder.nullable().optional() }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => engine.updateAsset(input.id, { filename: input.filename, folder: input.folder }))
});

const assetsReplaceContent = defineAction({
  name: "assets.replaceContent",
  title: "Edit a text file",
  description: "Replaces a text file's content (up to 1 MB). The file keeps its ID, so documents using it see the new content.",
  input: z.object({ id: assetId, content: z.string() }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => engine.replaceContent(input.id, new TextEncoder().encode(input.content).buffer as ArrayBuffer))
});

const assetsDelete = defineAction({
  name: "assets.delete",
  title: "Delete a file",
  description: "Moves a file to the trash. Fails with Conflict while a document uses it.",
  input: z.object({ id: assetId }),
  annotations: {},
  run: ({ engine }, input) => attempt(() => engine.deleteAsset(input.id))
});

const foldersList = defineAction({
  name: "folders.list",
  title: "List folders",
  description: "Every media folder with the number of files directly in it.",
  input: z.object({}),
  annotations: { readOnly: true },
  run: ({ engine }) => attempt(async () => ({ folders: await engine.listFolders() }))
});

const foldersCreate = defineAction({
  name: "folders.create",
  title: "Create a folder",
  description: "Creates a media folder, and its parents.",
  input: z.object({ path: folder }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => engine.createFolder(input.path))
});

const foldersMove = defineAction({
  name: "folders.move",
  title: "Rename or move a folder",
  description: "Moves a folder with its files and subfolders.",
  input: z.object({ from: folder, to: folder }),
  annotations: {},
  run: ({ engine }, input) => attempt(() => engine.moveFolder(input.from, input.to))
});

const foldersDelete = defineAction({
  name: "folders.delete",
  title: "Delete a folder",
  description: "Deletes an empty folder and its empty subfolders.",
  input: z.object({ path: folder }),
  annotations: {},
  run: ({ engine }, input) => attempt(() => engine.deleteFolder(input.path))
});

// --- Trash ---------------------------------------------------------------------

const trashList = defineAction({
  name: "trash.list",
  title: "List the trash",
  description: "Deleted documents, translations and files this user may restore, newest first, and how many days they're kept.",
  input: z.object({}),
  annotations: { readOnly: true },
  run: ({ engine }) => attempt(() => engine.listTrash())
});

const trashGet = defineAction({
  name: "trash.get",
  title: "Get a trashed item",
  description: "A deleted document's fields in each language, or a deleted file's details.",
  input: z.object({ id: trashId }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(() => engine.trashDetail(input.id))
});

const trashRestore = defineAction({
  name: "trash.restore",
  title: "Restore from the trash",
  description: "Puts a document or file back as it was, published state included. Files the document used come back with it.",
  input: z.object({ id: trashId }),
  annotations: {},
  run: ({ engine }, input) => attempt(() => engine.restoreTrash(input.id))
});

const trashPurge = defineAction({
  name: "trash.purge",
  title: "Delete permanently",
  description: "Deletes a trashed item for good, with its version history or the file's content. Can't be undone.",
  input: z.object({ id: trashId }),
  annotations: { destructive: true },
  run: ({ engine }, input) => attempt(() => engine.purgeTrash(input.id))
});

const trashEmpty = defineAction({
  name: "trash.empty",
  title: "Empty the trash",
  description: "Permanently deletes everything in the trash this user may delete. Can't be undone.",
  input: z.object({}),
  annotations: { destructive: true },
  run: ({ engine }) => attempt(() => engine.emptyTrash())
});

// --- Site ----------------------------------------------------------------------

const siteGet = defineAction({
  name: "site.get",
  title: "Get site settings",
  description: "The site's name, accent colour and icon.",
  input: z.object({}),
  annotations: { readOnly: true },
  run: ({ engine, host }) => attempt(() => engine.site(host))
});

const siteUpdate = defineAction({
  name: "site.update",
  title: "Update site settings",
  description: "Changes the site's name, accent colour (#rrggbb, or null for the default) or icon (an image's asset ID, or null).",
  input: z.object({
    name: z.string().optional(),
    accent: z.string().nullable().optional(),
    icon: z.string().nullable().optional().describe("Asset ID of an image")
  }),
  annotations: { idempotent: true },
  run: ({ engine, host }, input) => attempt(() => engine.updateSite(input, host))
});

/** Every built-in action, by name. Surfaces are generated from this list. */
export const coreActions = {
  [schemaList.name]: schemaList,
  [schemaGet.name]: schemaGet,
  [documentsList.name]: documentsList,
  [documentsGet.name]: documentsGet,
  [documentsCreate.name]: documentsCreate,
  [documentsUpdate.name]: documentsUpdate,
  [documentsDelete.name]: documentsDelete,
  [documentsPublish.name]: documentsPublish,
  [documentsUnpublish.name]: documentsUnpublish,
  [documentsReferences.name]: documentsReferences,
  [documentsVersions.name]: documentsVersions,
  [documentsVersion.name]: documentsVersion,
  [documentsRestoreVersion.name]: documentsRestoreVersion,
  [documentsSchedule.name]: documentsSchedule,
  [documentsUnschedule.name]: documentsUnschedule,
  [assetsList.name]: assetsList,
  [assetsGet.name]: assetsGet,
  [assetsUpload.name]: assetsUpload,
  [assetsUpdate.name]: assetsUpdate,
  [assetsReplaceContent.name]: assetsReplaceContent,
  [assetsDelete.name]: assetsDelete,
  [foldersList.name]: foldersList,
  [foldersCreate.name]: foldersCreate,
  [foldersMove.name]: foldersMove,
  [foldersDelete.name]: foldersDelete,
  [trashList.name]: trashList,
  [trashGet.name]: trashGet,
  [trashRestore.name]: trashRestore,
  [trashPurge.name]: trashPurge,
  [trashEmpty.name]: trashEmpty,
  [siteGet.name]: siteGet,
  [siteUpdate.name]: siteUpdate
};

export type CoreActions = typeof coreActions;
