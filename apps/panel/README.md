# vibe-cms panel

The agency's hub: sign in once, pick a site, edit it. Sites trust your org (a domain you own, in their `VIBE_ORG`), find this hub through the org's DNS record, and are added by URL; each site decides what you may do there. The editor, the CLI and AI agents all sign in here.

## Deploy

The easy way: `bunx vibe-cms admin deploy` asks for everything below, runs and shows each `wrangler` command, and prints the setup link at the end (`vibe-cms docs cli`). The steps by hand:

1. Register an OIDC client with your identity provider. Redirect URI: `https://<panel host>/auth/callback`.
2. Create the database: `bunx wrangler d1 create vibe-panel`, and put its ID in `wrangler.jsonc`.
3. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `PANEL_ALLOW` in `wrangler.jsonc`, and the secret with `bunx wrangler secret put OIDC_CLIENT_SECRET`.
4. Set `VIBE_ORG` to your org's domain (e.g. `my-agency.com`) and `PANEL_URL` to the panel's address. Point the org at the panel with a DNS record: `_vibe-hub.my-agency.com TXT "https://<panel host>"`. Optionally set `OIDC_ROLES_CLAIM` (e.g. `groups`) to pass that identity provider claim to sites as roles.
5. Create the signing key, a Worker secret that can't be read back: `bunx vibe-cms hub keygen | bunx wrangler secret put HUB_SIGNING_KEY`.
6. For backups, create the archive with `bunx wrangler r2 bucket create vibe-panel-backups`. The bucket binding and the cron trigger are already in `wrangler.jsonc`; remove them to run without backups.
7. Optionally white-label it with `PANEL_NAME`, `PANEL_ACCENT` (`#rrggbb`) and `PANEL_ICON` (an image URL).
8. `bun run deploy`.
9. **Claim it.** Until the panel has an owner, nobody can sign in. It prints a one-time setup link to its logs (`bunx wrangler tail`): `https://<panel host>/#setup=…`. (With `vibe-cms admin deploy`, the link is printed by the wizard, using a `PANEL_SETUP_TOKEN` secret.) Open it and sign in: you become the panel's owner, and the link stops working.

Sites that should appear in this panel are deployed with the same org:

```jsonc
// the site's wrangler.jsonc
"vars": { "VIBE_ORG": "my-agency.com" }
```

If the panel and a site are both on `workers.dev` in one Cloudflare account, both Workers need the `global_fetch_strictly_public` compatibility flag, or Cloudflare blocks them from calling each other (error 1042; `vibe-cms docs deploy` has the details). This panel's `wrangler.jsonc` has it.

A site deployed without `VIBE_ORG` logs a one-time claim link instead (`https://<site>/_vibe/admin/#claim=…`). Paste it in the panel's **Add a site** box, or run `vibe-cms admin attach "<link>"`: the panel tells the site its org (the site checks the `_vibe-hub` record and the hub's keys first) and adds it. Over HTTP that is `POST /api/sites/attach` (signed in) or `POST /site-attach` (OAuth bearer, not for read-only connections) with `{ "link", "templateId"? }`; agents use the `sites_attach` MCP tool.

The panel signs each signed-in user a short-lived token for one site at a time, issued by the org, with the identity provider's claims (email, name, …) passed through. Sites check it against the panel's keys at `/.well-known/jwks.json` and resolve the role names against their own stored roles. Site editors only open inside the panel; the panel's own URLs (`/s/<site id>/…`) are the links to bookmark.

## Identity providers

Any OpenID Connect provider works. The panel reads the provider's discovery document (`<issuer>/.well-known/openid-configuration`; pasting the discovery URL as the issuer is fine) and adapts to it: it authenticates at the token endpoint the way the provider lists (HTTP Basic or in the body), asks for `offline_access` when the provider offers it so sign-ins can be renewed, and accepts a refresh that returns no new ID token. `vibe-cms admin deploy` checks the provider before deploying and says what won't work.

| Variable | What |
|---|---|
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The provider and the client registered with it. Redirect URI: `https://<panel>/auth/callback`. |
| `PANEL_ALLOW` | Email domains or group names allowed in. Empty: whoever the provider lets in (nobody sees a site without a role on it). |
| `OIDC_TRUST_EMAIL` | `1` to count the provider's emails as verified when it doesn't say. Domain rules in `PANEL_ALLOW` and invites by email need a verified email. |
| `OIDC_SCOPES` | Overrides the default `openid email profile` (plus `offline_access` where offered). |
| `OIDC_ROLES_CLAIM` | The claim with group or role values: for `PANEL_ALLOW` group rules, and passed to sites as roles. A full name like `https://app/roles`, or a dotted path into nested claims, works. |

- **Clerk:** add an OAuth application (Dashboard → OAuth applications) with scopes `openid email profile offline_access`, and copy its client secret when it's shown. The issuer is your Clerk frontend URL (`https://<name>.clerk.accounts.dev`, or `https://clerk.<your domain>`). Clerk's tokens don't list `email_verified`, so set `OIDC_TRUST_EMAIL=1` (the wizard asks) if your instance verifies emails.
- **Cloudflare Access:** add a SaaS application of type OIDC (Zero Trust → Access controls → Applications) with the scopes `openid`, `email`, `profile` and, if group names should decide who signs in, `groups`; the issuer is `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`. Access policies decide who can sign in, so `PANEL_ALLOW` can stay empty. If the application issues no refresh tokens, people sign in again when their ID token expires. Set `OIDC_TRUST_EMAIL=1` (the wizard asks).
- **Changing the issuer** gives every member a new identity (it's `<issuer>|<subject>`), so roles, site access and ownership don't carry over.

## People, site access and templates

`PANEL_ALLOW` decides who may sign in; the panel decides what they see.

- **People** (the top bar): members and their hub role. `owner` (one, from the setup link) and `admin` see and manage every site; `member` sees only sites they're given. Custom hub roles (the **Hub roles** tab) pick from five permissions: managing people, managing hub roles, managing templates, adding sites and removing sites. Anyone but the owner and admins can only create hub roles, and give people hub roles, within their own permissions. Invite people by email address with a role; it becomes theirs when they first sign in with that verified email. The panel sends no email: tell them its address yourself. Nobody but the owner can change or remove the owner, or hand the panel over.
- **Who manages a site:** the panel's owner and admins, whoever added it, and members an admin makes its owner. The panel tells the site so with a signed `siteAdmin` claim, and the site makes them owners there. Someone signed in without a member row sees only sites they have a role on.
- **People and roles** (in a site's menu, or the people icon next to an open site): give people the site's own roles, by email before they've signed in. The site's owners can give any of them; someone whose own role on the site has **Manage roles** can give roles within their own. The site editor's **Users** page shows and changes the same list, through the panel. Changes reach the site within about 10 minutes, when its session renews through the panel. The pickers list the roles the site has; the site keeps defining them, on its Roles page. Roles assigned here reach the site in the token's `roles` claim, along with `OIDC_ROLES_CLAIM` values.
- **Templates:** named sets of roles. Adding a site offers them (the default preselected, or "No roles") and writes the chosen one onto the site through its role API; rules for content types the site lacks are skipped and reported. If the site can't be reached, the apply stays pending and the cron retries it. **Re-apply a template…** on a site shows what it would add, overwrite or remove, and asks first. Editing a template never changes sites that already used it.

Existing panels have no owner after upgrading: the setup link is printed until someone claims it, and nobody else can sign in meanwhile.

## Moving the panel, renaming the org

- **New address:** add the new redirect URI at your identity provider, deploy the panel there, and change the `_vibe-hub` TXT record. Sites follow within the record's TTL.
- **New org name:** add the new org's `_vibe-hub` record, change `VIBE_ORG` and deploy. The panel asks every site on its previous orgs to move (from the cron, or now with `POST /api/org/moves`), and keeps signing for the old org until each site accepts, 72 hours later unless someone cancels it in the site's editor. `GET /api/org` shows where the org's record points and how many sites trust which org.
- **New signing key:** `bunx vibe-cms hub keygen | bunx wrangler secret put HUB_SIGNING_KEY`. Sites fetch it the first time they see it.

## Backups

Sites that add `backups: true` to their config are backed up every day into the `BACKUPS` bucket. Set the schedule and how many snapshots to keep under the account menu's **Backup schedule**, and override them for one site in its **Backups** (in the site's menu). Restores run from there too, for the site's owners on the panel (whose role on the site is `owner`). See `vibe-cms docs backups`.

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
