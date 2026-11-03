import { Result } from "better-result";
import { z } from "zod";
import { getSchema } from "../config.ts";
import * as backups from "../handler/backups.ts";
import { BACKUP_TABLE_NAMES, type BackupManifest, type BackupTable } from "../handler/backups.ts";
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
  description: "Documents of one type, drafts included, newest first unless sorted. `search` is full-text (each word matches as a prefix); with it, `total` counts matches, `all` counts the type, and `excerpts` maps document IDs to where the body matched.",
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

const documentsSearch = defineAction({
  name: "documents.search",
  title: "Search documents",
  description: "Full-text search across every content type you can read, drafts included, best matches first. Words match as prefixes; titles rank above body text.",
  input: z.object({
    query: z.string().min(1).max(200),
    locale,
    limit: z.number().int().min(1).max(50).optional()
  }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(() => engine.searchDocuments(input))
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
  run: ({ engine }) => attempt(() => engine.site())
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
  run: ({ engine }, input) => attempt(() => engine.updateSite(input))
});

// --- Backups -------------------------------------------------------------------

const backupTable = z.enum(BACKUP_TABLE_NAMES as [BackupTable, ...BackupTable[]]).describe("A table from `backups.manifest`'s `tables`");
const restoreId = z.string().describe("From `backups.restoreBegin`");
const manifestInput = z.object({
  format: z.number().int(),
  siteId: z.string(),
  name: z.string().nullable(),
  takenAt: z.number(),
  engine: z.string(),
  locales: z.array(z.string()),
  types: z.record(z.string(), z.object({ hash: z.string(), documents: z.number().int() })),
  tables: z.record(z.string(), z.number().int()),
  files: z.object({ count: z.number().int(), bytes: z.number() })
}).describe("A snapshot's manifest, as `backups.manifest` returned it");

const backupsManifest = defineAction({
  name: "backups.manifest",
  title: "Describe a backup",
  description: "Starts a snapshot: the site's ID, content types with their schema hashes, and how many rows each table and how many files the backup has. Then read each table with `backups.export` and the files with `backups.files`. Most callers use `vibe-cms snapshot` or the panel, which do all of it.",
  input: z.object({}),
  annotations: { readOnly: true },
  run: ({ engine }) => attempt(() => backups.manifest(engine))
});

const backupsExport = defineAction({
  name: "backups.export",
  title: "Read a backup table",
  description: "One page of a table's rows, as stored. Pass `next` back as `after` until it's null.",
  input: z.object({ table: backupTable, after: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(() => backups.exportRows(engine, { ...input, limit: input.limit ?? 200 }))
});

const backupsFiles = defineAction({
  name: "backups.files",
  title: "List a backup's files",
  description: "One page of media files, trashed ones included, each with its size, etag and a signed download `url` good for an hour. Pass `next` back as `after` until it's null. `exists: false` means the bucket lost a file the library lists.",
  input: z.object({ after: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(() => backups.listFiles(engine, { ...input, limit: input.limit ?? 50 }))
});

const backupsCheck = defineAction({
  name: "backups.check",
  title: "Check a restore",
  description: "Whether a snapshot can be restored on this site, without changing anything: `problems` stop a restore, `warnings` don't. Also counts what the site has now.",
  input: z.object({ manifest: manifestInput }),
  annotations: { readOnly: true },
  run: ({ engine }, input) => attempt(() => backups.check(engine, input.manifest as BackupManifest))
});

const backupsRestoreBegin = defineAction({
  name: "backups.restoreBegin",
  title: "Start a restore",
  description: "Starts restoring a snapshot into staging tables; the live site doesn't change until `backups.restoreCommit`. Then send every table with `backups.restoreRows` and every file with `backups.restoreFile`. `resume` continues an unfinished restore by its ID.",
  input: z.object({ manifest: manifestInput, resume: z.string().optional(), force: z.boolean().optional().describe("Replace another unfinished restore") }),
  annotations: {},
  run: ({ engine }, input) => attempt(() => backups.restoreBegin(engine, { ...input, manifest: input.manifest as BackupManifest }))
});

const backupsRestoreRows = defineAction({
  name: "backups.restoreRows",
  title: "Send restore rows",
  description: "Writes up to 500 rows of one table, as `backups.export` returned them, into the restore's staging table. Sending rows again replaces them.",
  input: z.object({ restoreId, table: backupTable, rows: z.array(z.record(z.string(), z.unknown())).max(500) }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => backups.restoreRows(engine, input))
});

const backupsRestoreFile = defineAction({
  name: "backups.restoreFile",
  title: "Send a restore file",
  description: "Whether the site needs a file's bytes: `present` when it already has them, else an `upload` link (PUT the bytes) or, for files over 90 MB, a `multipart` link. Send the assets and trash tables first.",
  input: z.object({
    restoreId,
    key: z.string(),
    size: z.number().int().min(0),
    mime: z.string(),
    etag: z.string().optional(),
    lost: z.boolean().optional().describe("The snapshot has no copy of this file; restore its asset without it")
  }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => backups.restoreFile(engine, input))
});

const backupsRestoreCommit = defineAction({
  name: "backups.restoreCommit",
  title: "Finish a restore",
  description: "Replaces the site's content with the restore's in one transaction, after checking each table has `expected` rows and every file arrived. Fails without changing anything otherwise. Can't be undone except by restoring another snapshot, so take one first.",
  input: z.object({ restoreId, expected: z.record(z.string(), z.number().int().min(0)).describe("Rows per table, from the snapshot's manifest") }),
  annotations: { destructive: true },
  run: ({ engine }, input) => attempt(() => backups.restoreCommit(engine, { restoreId: input.restoreId, expected: input.expected as Partial<Record<BackupTable, number>> }))
});

const backupsRestoreCancel = defineAction({
  name: "backups.restoreCancel",
  title: "Cancel a restore",
  description: "Abandons an unfinished restore. The site stays as it was.",
  input: z.object({ restoreId }),
  annotations: { idempotent: true },
  run: ({ engine }, input) => attempt(() => backups.restoreCancel(engine, input))
});

const backupsRestoreStatus = defineAction({
  name: "backups.restoreStatus",
  title: "Get a restore's progress",
  description: "The unfinished restore, if there is one: who started it, when, and how many rows and files it has so far.",
  input: z.object({}),
  annotations: { readOnly: true },
  run: ({ engine }) => attempt(() => backups.restoreStatus(engine))
});

/** Every built-in action, by name. Surfaces are generated from this list. */
export const coreActions = {
  [schemaList.name]: schemaList,
  [schemaGet.name]: schemaGet,
  [documentsList.name]: documentsList,
  [documentsSearch.name]: documentsSearch,
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
  [siteUpdate.name]: siteUpdate,
  [backupsManifest.name]: backupsManifest,
  [backupsExport.name]: backupsExport,
  [backupsFiles.name]: backupsFiles,
  [backupsCheck.name]: backupsCheck,
  [backupsRestoreBegin.name]: backupsRestoreBegin,
  [backupsRestoreRows.name]: backupsRestoreRows,
  [backupsRestoreFile.name]: backupsRestoreFile,
  [backupsRestoreCommit.name]: backupsRestoreCommit,
  [backupsRestoreCancel.name]: backupsRestoreCancel,
  [backupsRestoreStatus.name]: backupsRestoreStatus
};

export type CoreActions = typeof coreActions;
