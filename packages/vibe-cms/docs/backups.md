# Backups

How to take snapshots of a site's content and media, keep them outside the site, and restore them onto the same site or another one. Each step is small and retried, and a restore changes nothing until it finishes.

A snapshot, in the panel or in a `.vibe` file, holds everything editors can change: documents (drafts, published copies, every translation), version history, schedules, the media library and its files, folders, the trash, and the site's name, accent and icon. Code isn't in it, since it lives in your repository. Neither are sessions, the session secret, the site's ID or the search index: a site restored from a snapshot keeps its own identity and sign-in, and rebuilds its search index.

## From the panel

An agency panel (`apps/panel` in the vibe-cms repository) can back up every site in it on a schedule, keep the snapshots in its own R2 bucket, and restore them from the site's Backups dialog.

1. Let the panel in. The site already trusts it with `auth: hub({ url })`; in the site's config, also add:

   ```ts
   backups: true
   ```

   The site then accepts short-lived backup tokens its hub signs for this site, and only for backup actions. They can't read or edit content through any other action, change settings, or sign anyone in.
2. Give the panel an archive: an R2 bucket bound as `BACKUPS`, `PANEL_URL` set to its address, and the cron trigger. The panel's `wrangler.jsonc` has all three.
3. Set the schedule under the account menu's **Backup schedule**: the hour (UTC), and how many daily, weekly and monthly snapshots to keep. The defaults are 14 daily, 8 weekly and 12 monthly. Any site can have its own schedule in its Backups dialog.

Runs are a queue in the panel's D1. While a run works, it renews a two-minute lease. If the Worker stops mid-run, the cron trigger (every five minutes) takes the run over once the lease lapses, and the runner picks up where it was. Failures are retried with growing delays, five attempts in all. A site that refuses the panel fails at once, and the dialog says what to add to its config. Each site has at most one run at a time.

Each snapshot in a site's Backups dialog downloads as a `.vibe` file, the same format `vibe-cms import` reads.

Restoring from the panel takes a snapshot of the site as it is first (kept 30 days, labelled "Before a restore"), then restores and checks the result. A restore needs `backups: true` in the user's own role on that site: the panel asks the site, through the user's session, before it queues the restore. After pruning old snapshots, the panel deletes files that no remaining snapshot uses.

Removing a site from the panel keeps its snapshots in the archive.

## From the CLI: `.vibe` files

The CLI moves a site's content as one file. A `.vibe` file is a gzipped tar of one snapshot with its media, so `tar -xzf site.vibe` opens it.

```sh
bunx vibe-cms export --site http://localhost:4321
bunx vibe-cms login https://edit.my-agency.com
bunx vibe-cms import ct-moving-2026-11-02-1830.vibe --site https://ctmoving.com --dry-run
bunx vibe-cms import ct-moving-2026-11-02-1830.vibe --site https://ctmoving.com
```

- `export` writes `<site name>-<date>-<time>.vibe` in the current folder (`--file` chooses the name). It works in a temporary folder and only renames the finished file into place, so an interrupted export leaves nothing behind.
- `import` checks the file against the site first and prints what will change, table by table. `--dry-run` stops there. Then it asks you to confirm (`--yes` skips this), exports the site as it is to `<site>-before-import-<date>.vibe` next to the file (`--no-safety-export` skips this), imports, and checks the site against the file.
- Running an interrupted `import` again resumes it, and doesn't export the site a second time, since nothing on the site has changed yet.

Inside, `manifest.json` comes first, then `complete.json`, `tables/*.jsonl` (one row per line, as stored), `files.json` (the file list) and the files under `files/`. Both commands stream, so a large site never has to fit in memory.

## Restoring safely

1. **Check** (`backups.check`): a snapshot that has documents of a content type the site doesn't define can't be restored, because those documents would be unreadable. Deploy the code that defines the type first. Schema changes since the snapshot and missing languages are warnings: documents restore as they were saved, and any that no longer fit show their issues in the editor (`vibe-cms docs schema-changes`).
2. **Stage** (`backups.restoreBegin`, `backups.restoreRows`, `backups.restoreFile`): rows go into staging tables, not the live ones. Files go straight into the bucket, and a file that's already there with the same size and etag isn't sent again. Files over 90 MB go up in 50 MB parts, so no single request body is too large.
3. **Commit** (`backups.restoreCommit`): this checks that every table has the snapshot's row count and that every file arrived. Then it replaces the live tables in one D1 batch, which is a transaction, and rebuilds the search index. If anything is missing, it refuses and the site stays as it was.

A failure at any point before the commit leaves the live site untouched. Run the same restore again and it picks up the unfinished restore (`resumed`): rows are sent again (sending them twice changes nothing), and files already uploaded are skipped. Only one restore runs at a time. `backups.restoreStatus` shows the one in progress, `backups.restoreCancel` abandons it, and `force` replaces one that was left behind.

Network errors, rate limits and platform errors (5xx) are retried with backoff, five attempts per step. Refusals from the CMS, such as a permission or a failed check, fail at once with the CMS's message.

Edits made while a snapshot is being taken can land in it or not. The snapshot records what it actually saved and warns when a table changed during the run. A file the media library lists but the bucket has lost is left out of the snapshot with a warning. When restored, its asset comes back without the file.

## The actions

Backups are ordinary actions, so REST (`POST /_vibe/api/actions/backups.manifest`), MCP, the CLI (`vibe-cms backups manifest`) and your own scripts all use the same steps. File bytes don't travel inside action calls. `backups.files` and `backups.restoreFile` hand out signed links to `/_vibe/api/backups/files/…` that are good for an hour, and the bytes stream between the caller and R2 through them.

| Action | What it does |
|---|---|
| `backups.manifest` | Starts a snapshot: site ID, content types with schema hashes, row counts, file totals |
| `backups.export` | One page of a table's rows (`next` → `after`) |
| `backups.files` | One page of files with a signed download link each |
| `backups.check` | Whether a manifest can be restored here, and what the site has now |
| `backups.restoreBegin` | Starts or resumes a restore into staging |
| `backups.restoreRows` | Up to 500 rows of one table into staging |
| `backups.restoreFile` | `present`, or a link to upload the bytes to |
| `backups.restoreCommit` | Checks, then swaps everything in at once |
| `backups.restoreCancel`, `backups.restoreStatus` | Abandon or inspect the unfinished restore |

The runner the CLI and the panel share is exported from `vibe-cms/backups`: `takeSnapshot`, `planRestore`, `restoreSnapshot` and `verifyRestore` work with any `BackupStore` (the panel's is its bucket), and `packSnapshot` and `unpackSnapshot` turn a stored snapshot into a `.vibe` stream and back.

## Who may

`backups: true` on a role (`vibe-cms docs permissions`) allows every backup action. So does the site's hub when the config sets `backups: true`, with its own tokens and for nothing else. A snapshot reads every document and file, drafts included, and a restore replaces them all, so no other rule implies it except `all`. Development sessions have it.
