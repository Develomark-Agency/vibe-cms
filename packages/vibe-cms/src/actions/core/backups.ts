import { z } from "zod";
import * as snapshots from "../../handler/backups.ts";
import { BACKUP_TABLE_NAMES, type BackupManifest, type BackupTable } from "../../handler/backups.ts";
import { base, router } from "../define.ts";

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

const backupsManifest = base({
  summary: "Describe a backup",
  description: "Starts a snapshot: the site's ID, content types with their schema hashes, and how many rows each table and how many files the backup has. Then read each table with `backups.export` and the files with `backups.files`. Most callers use `vibe-cms snapshot` or the panel, which do all of it.",
  readOnly: true,
  audit: "read"
})
  .handler(({ context: { engine } }) => snapshots.manifest(engine));

const backupsExport = base({
  summary: "Read a backup table",
  description: "One page of a table's rows, as stored. Pass `next` back as `after` until it's null.",
  readOnly: true,
  audit: "read"
})
  .input(z.object({
    table: backupTable,
    after: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional()
  }))
  .handler(({ context: { engine }, input }) => snapshots.exportRows(engine, { ...input, limit: input.limit ?? 200 }));

const backupsFiles = base({
  summary: "List a backup's files",
  description: "One page of media files, trashed ones included, each with its size, etag and a signed download `url` good for an hour. Pass `next` back as `after` until it's null. `exists: false` means the bucket lost a file the library lists.",
  readOnly: true,
  audit: "read"
})
  .input(z.object({
    after: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional()
  }))
  .handler(({ context: { engine }, input }) => snapshots.listFiles(engine, { ...input, limit: input.limit ?? 50 }));

const backupsCheck = base({
  summary: "Check a restore",
  description: "Whether a snapshot can be restored on this site, without changing anything: `problems` stop a restore, `warnings` don't. Also counts what the site has now.",
  readOnly: true
})
  .input(z.object({ manifest: manifestInput }))
  .handler(({ context: { engine }, input }) => snapshots.check(engine, input.manifest as BackupManifest));

const backupsRestoreBegin = base({
  summary: "Start a restore",
  description: "Starts restoring a snapshot into staging tables; the live site doesn't change until `backups.restoreCommit`. Then send every table with `backups.restoreRows` and every file with `backups.restoreFile`. `resume` continues an unfinished restore by its ID."
})
  .input(z.object({
    manifest: manifestInput,
    resume: z.string().optional(),
    force: z.boolean().optional().describe("Replace another unfinished restore")
  }))
  .handler(({ context: { engine }, input }) => snapshots.restoreBegin(engine, { ...input, manifest: input.manifest as BackupManifest }));

const backupsRestoreRows = base({
  summary: "Send restore rows",
  description: "Writes up to 500 rows of one table, as `backups.export` returned them, into the restore's staging table. Sending rows again replaces them.",
  idempotent: true
})
  .input(z.object({
    restoreId,
    table: backupTable,
    rows: z.array(z.record(z.string(), z.unknown())).max(500)
  }))
  .handler(({ context: { engine }, input }) => snapshots.restoreRows(engine, input));

const backupsRestoreFile = base({
  summary: "Send a restore file",
  description: "Whether the site needs a file's bytes: `present` when it already has them, else an `upload` link (PUT the bytes) or, for files over 90 MB, a `multipart` link. Send the assets and trash tables first.",
  idempotent: true
})
  .input(z.object({
    restoreId,
    key: z.string(),
    size: z.number().int().min(0),
    mime: z.string(),
    etag: z.string().optional(),
    lost: z.boolean().optional().describe("The snapshot has no copy of this file; restore its asset without it")
  }))
  .handler(({ context: { engine }, input }) => snapshots.restoreFile(engine, input));

const backupsRestoreCommit = base({
  summary: "Finish a restore",
  description: "Replaces the site's content with the restore's in one transaction, after checking each table has `expected` rows and every file arrived. Fails without changing anything otherwise. Can't be undone except by restoring another snapshot, so take one first.",
  destructive: true
})
  .input(z.object({
    restoreId,
    expected: z.record(z.string(), z.number().int().min(0)).describe("Rows per table, from the snapshot's manifest")
  }))
  .handler(({ context: { engine }, input }) => snapshots.restoreCommit(engine, { restoreId: input.restoreId, expected: input.expected as Partial<Record<BackupTable, number>> }));

const backupsRestoreCancel = base({
  summary: "Cancel a restore",
  description: "Abandons an unfinished restore. The site stays as it was.",
  idempotent: true
})
  .input(z.object({ restoreId }))
  .handler(({ context: { engine }, input }) => snapshots.restoreCancel(engine, input));

const backupsRestoreStatus = base({
  summary: "Get a restore's progress",
  description: "The unfinished restore, if there is one: who started it, when, and how many rows and files it has so far.",
  readOnly: true
})
  .handler(({ context: { engine } }) => snapshots.restoreStatus(engine));

export const backups = router({
  manifest: backupsManifest,
  export: backupsExport,
  files: backupsFiles,
  check: backupsCheck,
  restoreBegin: backupsRestoreBegin,
  restoreRows: backupsRestoreRows,
  restoreFile: backupsRestoreFile,
  restoreCommit: backupsRestoreCommit,
  restoreCancel: backupsRestoreCancel,
  restoreStatus: backupsRestoreStatus
});
