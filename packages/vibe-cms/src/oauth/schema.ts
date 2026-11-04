import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The OAuth server's tables, named `<prefix>oauth_clients` and so on: `""` for the hub, `"vibe_"` for a
 * site. Re-export the result from the database's schema so its migrations create them.
 */
export function oauthTables(prefix: string) {
  const clients = sqliteTable(`${prefix}oauth_clients`, {
    id: text().primaryKey(),
    secret_hash: text(),
    name: text().notNull(),
    uri: text(),
    redirect_uris: text().notNull(),
    auth_method: text().$type<"none" | "client_secret_post" | "client_secret_basic">().notNull(),
    created_at: integer().notNull()
  });
  // An authorization in progress: from the client's /oauth/authorize to the user's answer.
  const requests = sqliteTable(`${prefix}oauth_requests`, {
    id: text().primaryKey(),
    client_id: text().notNull(),
    redirect_uri: text().notNull(),
    challenge: text().notNull(),
    state: text(),
    scope: text().notNull(),
    user: text(),
    expires_at: integer().notNull()
  });
  const codes = sqliteTable(`${prefix}oauth_codes`, {
    hash: text().primaryKey(),
    grant_id: text().notNull(),
    client_id: text().notNull(),
    redirect_uri: text().notNull(),
    challenge: text().notNull(),
    expires_at: integer().notNull()
  });
  // A connection: who approved it, what it may do, and whatever the server keeps with it (`payload`).
  const grants = sqliteTable(`${prefix}oauth_grants`, {
    id: text().primaryKey(),
    client_id: text().notNull(),
    user: text().notNull(),
    payload: text().notNull(),
    scope: text().notNull(),
    access_hash: text().unique(),
    access_expires_at: integer(),
    refresh_hash: text().unique(),
    refresh_expires_at: integer(),
    created_at: integer().notNull(),
    last_used_at: integer()
  });
  return { clients, requests, codes, grants };
}

export type OAuthTables = ReturnType<typeof oauthTables>;
