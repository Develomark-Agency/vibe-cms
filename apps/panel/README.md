# vibe-cms panel

The agency's hub: sign in once, pick a site, edit it. Sites trust your org (a domain you own, in their `VIBE_ORG`), find this hub through the org's DNS record, and are added by URL; each site decides what you may do there. The editor, the CLI and AI agents all sign in here.

## Deploy

1. Register an OIDC client with your identity provider. Redirect URI: `https://<panel host>/auth/callback`.
2. Create the database: `bunx wrangler d1 create vibe-panel`, and put its ID in `wrangler.jsonc`.
3. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `PANEL_ALLOW` in `wrangler.jsonc`, and the secret with `bunx wrangler secret put OIDC_CLIENT_SECRET`.
4. Set `VIBE_ORG` to your org's domain (e.g. `my-agency.com`) and `PANEL_URL` to the panel's address. Point the org at the panel with a DNS record: `_vibe-hub.my-agency.com TXT "https://<panel host>"`. Optionally set `OIDC_ROLES_CLAIM` (e.g. `groups`) to pass that identity provider claim to sites as roles.
5. Create the signing key, a Worker secret that can't be read back: `bunx vibe-cms hub keygen | bunx wrangler secret put HUB_SIGNING_KEY`.
6. For backups, create the archive with `bunx wrangler r2 bucket create vibe-panel-backups`. The bucket binding and the cron trigger are already in `wrangler.jsonc`; remove them to run without backups.
7. Optionally white-label it with `PANEL_NAME`, `PANEL_ACCENT` (`#rrggbb`) and `PANEL_ICON` (an image URL).
8. `bun run deploy`.

Sites that should appear in this panel are deployed with the same org:

```jsonc
// the site's wrangler.jsonc
"vars": { "VIBE_ORG": "my-agency.com" }
```

The panel signs each signed-in user a short-lived token for one site at a time, issued by the org, with the identity provider's claims (email, name, …) passed through. Sites check it against the panel's keys at `/.well-known/jwks.json` and work out roles themselves. Site editors only open inside the panel; the panel's own URLs (`/s/<site id>/…`) are the links to bookmark.

## Moving the panel, renaming the org

- **New address:** add the new redirect URI at your identity provider, deploy the panel there, and change the `_vibe-hub` TXT record. Sites follow within the record's TTL.
- **New org name:** add the new org's `_vibe-hub` record, change `VIBE_ORG` and deploy. The panel asks every site on its previous orgs to move (from the cron, or now with `POST /api/org/moves`), and keeps signing for the old org until each site accepts, 72 hours later unless someone cancels it in the site's editor. `GET /api/org` shows where the org's record points and how many sites trust which org.
- **New signing key:** `bunx vibe-cms hub keygen | bunx wrangler secret put HUB_SIGNING_KEY`. Sites fetch it the first time they see it.

## Backups

Sites that add `backups: true` to their config are backed up every day into the `BACKUPS` bucket. Set the schedule and how many snapshots to keep under the account menu's **Backup schedule**, and override them for one site in its **Backups** (in the site's menu). Restores run from there too, for users whose role on that site has `backups: true`. See `vibe-cms docs backups`.

## AI agents

The panel is also an MCP server for every site in it: `https://<panel host>/mcp`. Anyone who can sign in to the panel can add that address to Claude, ChatGPT, Cursor or another agent as a custom connector; the account menu's **AI agents** shows it with a copy button.

1. The agent registers itself with the panel's OAuth server and opens the panel in a browser.
2. The user approves it (optionally read only) and signs in with the identity provider once more, so the agent gets a provider session of its own: signing out of the panel doesn't disconnect it, and disconnecting it doesn't sign anyone out.
3. The agent calls `sites_list`, then any action with a `site` argument. The panel gets a site session for the user through the same one-time-code handoff the editor uses, so each site still decides what that user may do.

## The CLI

`vibe-cms login my-agency.com` (or the panel's URL) connects the CLI the same way, for one project, and keeps the login in the OS keychain. `vibe-cms export`, `vibe-cms import` and every action command then get a site session from `POST /site-token` for whichever site they run against. `vibe-cms logout` revokes the connection (`POST /oauth/revoke`) and forgets it. A connection approved read-only can't get site tokens, since a site session can do whatever the user may.

Connected agents are listed under **AI agents**, where users can disconnect them. Nothing to configure: the OAuth endpoints are discovered from `/.well-known/oauth-protected-resource`.

## Develop

```sh
echo 'OIDC_CLIENT_SECRET=…' > .dev.vars
bun run dev
bun test          # sign-in and handoff against a mock identity provider and a real site handler
```

For working on sites without an identity provider, use the local panel instead: `bunx vibe-cms admin`.
