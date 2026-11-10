import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { oauthTables } from "../oauth/schema.ts";

/**
 * The engine's tables: the one definition of the database. Row types come from here, queries are
 * checked against it, and `bun run db:generate` turns changes to it into a migration.
 *
 * Not here, because they depend on each site's config and are installed by `migrate()`: the
 * expression indexes for `indexed` fields, the full-text table `vibe_search` and its triggers.
 */

export const meta = sqliteTable("vibe_meta", {
  key: text().primaryKey(),
  value: text().notNull()
});

/**
 * One row per document and locale: what it is and its live copy. Unpublished changes live on each
 * person's branch in `vibe_branches`. `updated_at` and `updated_by` are the last save to any branch, or the last publish.
 */
export const documents = sqliteTable("vibe_documents", {
  id: text().notNull(),
  type: text().notNull(),
  locale: text().notNull(),
  published: text(),
  published_ver: integer(),
  schema_hash: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  published_at: integer(),
  updated_by: text()
}, t => [
  primaryKey({ columns: [t.id, t.locale] }),
  index("vibe_documents_type").on(t.type, t.locale, t.updated_at)
]);

/**
 * Each person's working copy of a document in one locale: their candidate for publishing. Its changes
 * are a diff of `base` (the copy it started from: a published version, or another branch before the
 * first publish) against `data`. A branch with nothing left to publish is deleted.
 */
export const branches = sqliteTable("vibe_branches", {
  id: text().notNull(),
  locale: text().notNull(),
  /** The session subject whose branch it is. An agent's edits land on its user's branch. */
  owner: text().notNull(),
  owner_name: text(),
  /** The published version `base` is, or null when the branch started before the first publish. */
  base_ver: integer(),
  base: text(),
  data: text().notNull(),
  /** Where the last save came from: `ui` (the editor), `mcp`, `cli`, `rest`… */
  via: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull()
}, t => [primaryKey({ columns: [t.id, t.locale, t.owner] })]);

export const versions = sqliteTable("vibe_versions", {
  id: text().notNull(),
  locale: text().notNull(),
  ver: integer().notNull(),
  data: text().notNull(),
  author: text().notNull(),
  created_at: integer().notNull()
}, t => [primaryKey({ columns: [t.id, t.locale, t.ver] })]);

/**
 * Who did what, through which channel, and whether it worked: one row per action, written by the action
 * dispatcher (and the few routes that aren't actions). Append-only; the cron trigger prunes old rows.
 */
export const activity = sqliteTable("vibe_activity", {
  /** Time-ordered, so sorting by it sorts by time. */
  id: text().primaryKey(),
  at: integer().notNull(),
  /** The user's `sub`, or `system:cron` / `system:hub`. */
  actor: text().notNull(),
  actor_name: text(),
  via: text().notNull(),
  client: text(),
  on_behalf_of: text(),
  /** `documents.publish`, `plugin:stats.reset`. */
  action: text().notNull(),
  target_type: text(),
  target_id: text(),
  /** What the target was called when it happened (a document's title, a file's name), so entries stay readable after it changes or goes. */
  target_label: text(),
  locale: text(),
  ok: integer().notNull(),
  /** The error code when not ok. */
  error: text(),
  /** Short JSON: changed field paths, a version number, a role name. Never content, secrets or personal data. */
  summary: text()
}, t => [
  index("vibe_activity_at").on(t.at),
  index("vibe_activity_actor").on(t.actor, t.at),
  index("vibe_activity_target").on(t.target_id, t.at)
]);

export const schedules = sqliteTable("vibe_schedules", {
  id: text().notNull(),
  locale: text().notNull(),
  ver: integer(),
  action: text().$type<"publish" | "unpublish">().notNull(),
  run_at: integer().notNull(),
  created_by: text().notNull()
}, t => [
  primaryKey({ columns: [t.id, t.locale, t.action] }),
  index("vibe_schedules_run_at").on(t.run_at)
]);

export const assets = sqliteTable("vibe_assets", {
  id: text().primaryKey(),
  key: text().notNull(),
  folder: text(),
  filename: text().notNull(),
  mime: text().notNull(),
  size: integer().notNull(),
  meta: text().notNull(),
  created_at: integer().notNull(),
  created_by: text().notNull()
}, t => [index("vibe_assets_folder").on(t.folder, t.created_at)]);

/** Folders that exist on their own, so empty ones survive. Asset folders and their ancestors exist implicitly too. */
export const folders = sqliteTable("vibe_folders", {
  path: text().primaryKey(),
  created_at: integer().notNull()
});

/** Deleting moves rows here. Versions and R2 objects stay where they are until the item is purged. */
export const trash = sqliteTable("vibe_trash", {
  id: text().primaryKey(),
  kind: text().$type<"document" | "asset">().notNull(),
  /** Content type for documents; null for assets. */
  type: text(),
  item_id: text().notNull(),
  /** The one translation that was deleted; null when the whole document or a file was. */
  locale: text(),
  label: text().notNull(),
  /** JSON: the removed `vibe_documents` rows, or the `vibe_assets` row. */
  payload: text().notNull(),
  deleted_at: integer().notNull(),
  deleted_by: text().notNull()
}, t => [
  index("vibe_trash_deleted_at").on(t.deleted_at),
  index("vibe_trash_item").on(t.item_id)
]);

export const codes = sqliteTable("vibe_codes", {
  code: text().primaryKey(),
  payload: text().notNull(),
  expires_at: integer().notNull()
});

/** Sign-in for sites without an org (VIBE_ORG): people who may sign in, by email, with roles given in the editor. */
export const users = sqliteTable("vibe_users", {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text(),
  roles: text().notNull(),
  created_at: integer().notNull(),
  created_by: text().notNull(),
  last_sign_in_at: integer()
});

/** The site's roles, besides the built-in owner: edited on the editor's Roles page, or written by the hub from a template. */
export const roles = sqliteTable("vibe_roles", {
  name: text().primaryKey(),
  rules: text().notNull(),
  updated_by: text(),
  updated_at: integer().notNull()
});

export const passkeys = sqliteTable("vibe_passkeys", {
  id: text().primaryKey(),
  user_id: text().notNull(),
  public_key: text().notNull(),
  counter: integer().notNull(),
  transports: text(),
  created_at: integer().notNull(),
  last_used_at: integer()
});

/** Invite links, stored as hashes: one registers a passkey for that user. */
export const invites = sqliteTable("vibe_invites", {
  hash: text().primaryKey(),
  user_id: text().notNull(),
  created_by: text().notNull(),
  expires_at: integer().notNull()
});

/** Signed-in browsers: an httpOnly cookie names one, and the editor trades it for a session token. */
export const signins = sqliteTable("vibe_signins", {
  hash: text().primaryKey(),
  identity: text().notNull(),
  expires_at: integer().notNull()
});

/** Passkey challenges and OIDC logins in progress. */
export const challenges = sqliteTable("vibe_challenges", {
  id: text().primaryKey(),
  payload: text().notNull(),
  expires_at: integer().notNull()
});

/** The site as an OAuth server for agents and the CLI, when it signs people in itself (vibe-cms/oauth). */
const oauth = oauthTables("vibe_");
// drizzle-kit only sees top-level exports.
export const oauthClients = oauth.clients;
export const oauthRequests = oauth.requests;
export const oauthCodes = oauth.codes;
export const oauthGrants = oauth.grants;

export type DocumentRow = typeof documents.$inferSelect;
export type VersionRow = typeof versions.$inferSelect;
export type BranchRow = typeof branches.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type TrashRow = typeof trash.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
