import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { oauthTables } from "vibe-cms/db";

/**
 * The panel's tables: the one definition of its database. `bun run db:generate` turns changes to it
 * into a migration, which the panel applies on its first request.
 */

export const sites = sqliteTable("sites", {
  id: text().primaryKey(),
  url: text().notNull().unique(),
  name: text().notNull(),
  admin: text().notNull(),
  org: text(),
  added_by: text().notNull(),
  added_at: integer().notNull()
});

export const favorites = sqliteTable("favorites", {
  user: text().notNull(),
  site_id: text().notNull().references(() => sites.id, { onDelete: "cascade" })
}, t => [primaryKey({ columns: [t.user, t.site_id] })]);

export const sessions = sqliteTable("sessions", {
  id: text().primaryKey(),
  sub: text().notNull(),
  email: text(),
  name: text(),
  id_token: text().notNull(),
  refresh_token: text(),
  expires_at: integer().notNull()
});

export const logins = sqliteTable("logins", {
  state: text().primaryKey(),
  verifier: text().notNull(),
  nonce: text().notNull(),
  return_to: text().notNull(),
  expires_at: integer().notNull()
});

/** Agents and the CLI: the panel's OAuth server (vibe-cms/oauth). A connection's `payload` is its own provider session's id. */
const oauth = oauthTables("");
export const oauthClients = oauth.clients;
export const oauthRequests = oauth.requests;
export const oauthCodes = oauth.codes;
export const oauthGrants = oauth.grants;

/** Site sessions the panel holds for an agent, one per site, until they expire. */
export const agentSiteTokens = sqliteTable("agent_site_tokens", {
  grant_id: text().notNull(),
  site_id: text().notNull(),
  token: text().notNull(),
  expires_at: integer().notNull()
}, t => [primaryKey({ columns: [t.grant_id, t.site_id] })]);

export const panelMeta = sqliteTable("panel_meta", {
  key: text().primaryKey(),
  value: text().notNull()
});

/** site_id '*' is the default for every site; a site's own row overrides it. */
export const backupPolicies = sqliteTable("backup_policies", {
  site_id: text().primaryKey(),
  policy: text().notNull(),
  updated_by: text().notNull(),
  updated_at: integer().notNull()
});

export const backupRuns = sqliteTable("backup_runs", {
  id: text().primaryKey(),
  site_id: text().notNull(),
  kind: text().$type<"scheduled" | "manual" | "restore">().notNull(),
  snapshot: text(),
  status: text().$type<"queued" | "running" | "done" | "failed">().notNull(),
  attempts: integer().notNull().default(0),
  next_at: integer().notNull(),
  lease_until: integer(),
  progress: text(),
  state: text(),
  error: text(),
  requested_by: text(),
  created_at: integer().notNull(),
  started_at: integer(),
  finished_at: integer()
}, t => [
  index("backup_runs_site").on(t.site_id, t.created_at),
  index("backup_runs_due").on(t.status, t.next_at)
]);

export const backupSnapshots = sqliteTable("backup_snapshots", {
  id: text().primaryKey(),
  site_id: text().notNull(),
  taken_at: integer().notNull(),
  kind: text().$type<"scheduled" | "manual" | "safety">().notNull(),
  documents: integer().notNull(),
  files: integer().notNull(),
  bytes: integer().notNull(),
  warnings: text().notNull()
}, t => [index("backup_snapshots_site").on(t.site_id, t.taken_at)]);

export type SessionRow = typeof sessions.$inferSelect;
export type RunRow = typeof backupRuns.$inferSelect;
export type SnapshotRow = typeof backupSnapshots.$inferSelect;
export type SiteRow = typeof sites.$inferSelect;
