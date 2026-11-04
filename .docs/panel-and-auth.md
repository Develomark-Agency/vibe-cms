# Panel and auth

## The goal

An agency with 50 client sites logs in once at `edit.my-agency.com`, picks a site from a dropdown, and edits it. Launching a new site every week means adding its URL in the panel, never editing code or redeploying the panel.

## The pieces

| Piece | Holds | Runs |
|---|---|---|
| **Site** | Content, config, plugins, per-site permissions, **its own editor** | Inside your site's Worker (see [handler.md](./handler.md)) |
| **Identity provider** | Users and logins | Any OIDC provider you already use: Cloudflare Access, Google Workspace, Microsoft Entra, Okta, Clerk, Auth0, … |
| **Panel** | The shared site list, per-user favorites | A black box deployed once per agency, e.g. `edit.my-agency.com` |

vibe-cms does **not** run its own identity server. Logins belong to the identity provider, access rules and the editor belong to each site, and the panel is the agency's front door: sign-in, the site list, and a frame around each site's editor.

## Each site hosts its own editor

Every site serves a standalone admin app at `/_vibe/admin`: the vibe-cms admin core at that site's version, plus its widgets and admin plugins. It runs on the site's own origin, so its code can only ever act on that site.

The panel never loads a site's code into its own page. It shows the site's editor in a cross-origin **iframe** inside the panel's frame, the only place a deployed editor runs.

```
┌─ edit.my-agency.com ─────────────────────────────────────┐
│  [Site: Client 40 ▾]  ★ Favorites   Settings   Jane ▾    │  ← panel frame
├──────────────────────────────────────────────────────────┤
│ ┌─ iframe: client-40.com/_vibe/admin ──────────────────┐ │
│ │  Posts | Pages | Media          [Publish]            │ │  ← site's own editor
│ │  …                                                   │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

- **Panel frame:** agency-level things only. Site switcher, favorites, panel settings, account.
- **Site editor:** everything about the site, including its content navigation (posts, pages, media). The panel never renders a site's navigation or reads its schema.

Because each site brings its own editor, sites on different vibe-cms versions never have to agree with each other or with the panel. The only shared contract is the small message protocol below.

## Sites trust the org

The panel is the **hub** of an **org**: a domain the agency owns, like `my-agency.com`. A deployed site trusts the org, not the hub's address. Sign-in is the same for every site in an org, so it's deploy configuration, not code: the site gets one environment variable, and its config says nothing about sign-in.

```jsonc
// the site's wrangler.jsonc
"vars": { "VIBE_ORG": "my-agency.com" }
```

The site finds the hub through a DNS TXT record on the org, and fetches the hub's public keys from `<hub>/.well-known/jwks.json` at runtime. It keeps a copy of the keys in its database as a fallback, and has no secret to configure.

```
_vibe-hub.my-agency.com   TXT   "https://edit.my-agency.com"
```

The org, not the hub's address, is the `iss` of every hub token. Moving the hub to another address is then one DNS change: sites look the record up again within its TTL, and tokens in flight stay valid. `VIBE_ORG` may also be a URL, which makes that address the hub with no DNS lookup, for local setups.

Every site trusts **exactly one** org. Only the hub talks to the identity provider, so changing providers is a hub setting, not a change to every site.

Every way in goes through the hub: the editor, the CLI (`vibe-cms login my-agency.com`), agents (`/mcp`) and scheduled backups. The hub signs a short-lived token (ES256, five minutes) for **one site at a time**, `aud` set to that site's ID. A user's token carries the provider identity as `sub` (`<issuer>|<sub>`), the provider's other claims (email, `email_verified`, name) passed through, and `roles`: the values of the provider claim named in the hub's `OIDC_ROLES_CLAIM`, if set. The site verifies the token itself, without calling the hub, then works out roles from its own config.

```ts
// a hub token for one site
{
  "iss": "my-agency.com",
  "aud": "site-40",
  "sub": "https://accounts.google.com|10498…",
  "email": "jane@my-agency.com",
  "email_verified": true,
  "roles": ["agency-staff"],
  "exp": 1793000300
}
```

The hub's signing key is a Worker secret, `HUB_SIGNING_KEY` (`bunx vibe-cms hub keygen`). A secret can be set but not read back through the dashboard or the API, so a leaked database copy or API token doesn't leak the key every site trusts.

## Permissions live on the site

Anyone allowed into the panel sees every site in the shared list. Whether they can do anything on a site is decided by that site alone.

```ts
// vibe-cms.config.ts (site)
export default defineConfig({
  permissions: {
    roles: {
      "agency-staff": { all: true },
      "client-editor": {
        post: ["read", "write"],
        page: ["read", "write"],
        publish: false,
      },
      "translator-fr": {
        "*": ["read"],
        write: { locales: ["fr"] },
      },
    },
    users: {
      // keyed by verified email or `<issuer>|<sub>`
      "jane@my-agency.com": ["agency-staff"],
      "https://accounts.google.com|10498…": ["client-editor"],
    },
  },
});
```

- Roles come from the identity provider's claims (the hub's `OIDC_ROLES_CLAIM=groups` for Okta, Entra, Keycloak, …, passed on as `roles`), from `permissions.users`, or both.
- Users keyed by email require the `email_verified` claim.
- Site permissions and version history key on stable provider identity, never on anything panel-specific, so they survive the panel being recreated.

## Signing in

The panel's backend is the OIDC client (the "backend for frontend" pattern). It runs the provider's login flow, keeps the provider's tokens server-side, and gives the browser an httpOnly session cookie for the panel only. Browser code never sees a provider token.

## Opening a site: the one-time code handoff

```
hub backend ──POST /_vibe/api/session/code (hub token for site-40)──▶ site-40
                                        verifies with the hub's keys, checks iss / aud / exp,
                                        maps identity → roles
              ◀──────────── one-time code (single use, ~30s) ─────────────
panel ──code──▶ site-40's editor ──POST /_vibe/api/session (code)──▶ site-40
                                 ◀──────── site session token ───────────
```

1. The hub backend refreshes the user's provider sign-in if it's about to expire (so someone the provider dropped stops getting in), signs a token for this site, and sends it, server to server.
2. The site verifies it, works out the user's roles, and returns a **one-time code**.
3. The code reaches the site's editor (see below), which immediately trades it for a **site session token** that only works on that site.

```ts
// site session token, issued by the site for itself
{
  "iss": "https://site-40.com",
  "aud": "site-40",
  "sub": "https://accounts.google.com|10498…",
  "email": "jane@my-agency.com",
  "roles": ["agency-staff"],
  "exp": 1793000000
}
```

### The editor only runs inside the hub

The code arrives by `postMessage` from the panel, addressed only to the site's origin, and the session lives **in memory**. A deployed editor opened on its own has no way to sign in: it shows a link to the site's page in the hub (`<hub>/s/<site id>/`). Bookmarks and second tabs use the hub's URLs, which mirror the editor's location. Development editors (`vite dev`) still open on their own, signed in as the developer.

The session lives in memory, not in a cookie:

- Browsers block or partition cookies in cross-site iframes (Safari most strictly), so memory is the reliable option.
- It makes clickjacking moot: if any other website frames the editor, the editor has no session there, so there is nothing to trick a user into doing.
- If the iframe reloads, or the session expires, the editor asks the panel for a fresh code, with nothing shown to the user.

## The message protocol

The only contract between the panel and a site's editor. Small, versioned, and checked on both sides.

```ts
// panel → editor
type PanelMessage =
  | { type: "vibe:code"; code: string }
  | { type: "vibe:navigate"; path: string };          // e.g. deep link from the panel URL

// editor → panel
type EditorMessage =
  | { type: "vibe:ready"; protocol: 1 }
  | { type: "vibe:needCode" }                           // after a reload or session expiry
  | { type: "vibe:navigated"; path: string }            // panel mirrors it in its own URL
  | { type: "vibe:title"; title: string }
  | { type: "vibe:shortcut"; key: string };             // forwards panel shortcuts like ⌘K
```

```ts
// panel side
window.addEventListener("message", async (event) => {
  if (event.origin !== currentSite.origin) return;      // only the framed site
  const msg = event.data as EditorMessage;

  switch (msg.type) {
    case "vibe:needCode": {
      const code = await panelApi.codeFor(currentSite.id); // only ever for the framed site
      frame.contentWindow!.postMessage({ type: "vibe:code", code }, currentSite.origin);
      break;
    }
    case "vibe:navigated":
      history.replaceState(null, "", `/s/${currentSite.id}${msg.path}`);
      break;
    // …
  }
});
```

```ts
// editor side
window.addEventListener("message", async (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data as PanelMessage;
  if (msg.type === "vibe:code") {
    session = await exchangeCode(msg.code);             // kept in memory
  }
});

window.parent.postMessage({ type: "vibe:ready", protocol: 1 }, "*");
```

The editor's `ready` contains nothing sensitive, so it can be posted to any parent. Codes only ever flow from the panel to the framed site's origin, and the panel only requests codes for the site in the frame: if site 12's editor asks for site 40, it gets nothing.

## Switching sites

The site dropdown lives in the panel frame. Switching swaps the iframe to the other site and runs a fresh handoff.

## UX trade-offs of the iframe

- **URL sync.** The panel's URL (`/s/site-40/posts/123`) mirrors the editor's location through `navigated` messages, so deep links and the back button work.
- **Modals stay inside the iframe.** A site dialog dims only the editor area. Panel overlays (like a command palette) can still cover the iframe.
- **Keyboard shortcuts.** With focus inside the iframe, the panel doesn't see key presses, so the editor forwards panel shortcuts with `vibe:shortcut`.

## The panel is a black box

The panel has **no code config**. Its only settings are deploy-time environment variables:

```sh
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=1234.apps.googleusercontent.com
OIDC_CLIENT_SECRET=…
PANEL_ALLOW=my-agency.com        # who may use the panel: email domains, or a group claim value
PANEL_NAME="Acme Studio"         # optional white-labelling: the panel's name,
PANEL_ACCENT=#2563eb             #   accent colour (also used by framed sites without their own),
PANEL_ICON=https://…/logo.png    #   and logo
```

`PANEL_ALLOW` matters for providers like plain Google, where anyone with an account can sign in. Cloudflare Access can enforce this before requests reach the panel.

### The shared site list and favorites

When you first log in, there are no sites. Sites are added by URL, and the list is **shared by everyone using that panel**: one panel deployment is effectively one agency. Each user can favorite sites on top of that.

Sketch of the tables; the real definitions are Drizzle tables in `apps/panel/src/server/schema.ts` (see `storage.md`).

```sql
CREATE TABLE sites (
  id         TEXT PRIMARY KEY,      -- from the site's descriptor
  url        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  added_by   TEXT NOT NULL,         -- `<issuer>|<sub>`
  added_at   INTEGER NOT NULL
);

CREATE TABLE favorites (
  user       TEXT NOT NULL,         -- `<issuer>|<sub>`
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user, site_id)
);
```

Seeing a site in the list grants nothing. Sites where the handoff is refused show as "no access."

### Add site by URL

Every site publishes a public descriptor generated from its config:

```http
GET https://site-40.com/.well-known/vibe-cms

{
  "id": "site-40",
  "name": "Client 40",
  "org": "my-agency.com",
  "hub": "https://edit.my-agency.com",
  "orgMove": null,
  "backups": false,
  "admin": "https://site-40.com/_vibe/admin"
}
```

You paste a URL into the panel. The panel fetches the descriptor and adds the site only if `org` is its own. Otherwise it refuses: "This site trusts another org."

No secret is needed: the panel isn't proving who *owns* the site, only that the site *agreed* to trust this org. Only someone who controls the site's deployment can make that file say so, the same principle as file-based domain verification.

## Security model

**Browser side: isolated.** Each site's editor runs on its own origin. A malicious or compromised plugin, widget or dependency on site 12 can act on site 12 (plugins are trusted code), but cannot touch the panel's page, the panel's session, or any other site. Provider tokens never reach the browser.

**Server side: tokens for one site.** Sites never see a provider token. Each hub token is addressed to one site, so a compromised plugin's *server* code on site 12 can't replay what it receives to site 40. The hub's signing key is what every site trusts: it's a Worker secret, never stored in D1, so only code running in the hub can use it. Someone with the key could forge sign-ins to every site until it's replaced, the same as with any identity provider's keys. Replacing it locks them out: sites fetch the new key the first time they see a token signed with it.

**Revocation.** Sites don't check back with the hub, so a token works until it expires: five minutes for a hub token, 12 hours for the site session the editor or CLI trades it for. Removing someone from the identity provider stops new tokens at the next refresh of their provider sign-in.

## Shell forms

| Shell | Notes |
|---|---|
| Web panel | The default |
| Electron (future) | Same panel backend; each site's editor in its own frame or window. Requires Electron's standard hardening (no Node integration in the renderer, context isolation on) since editors are remote code |
| Local, `bunx vibe-cms admin` | For development, see below |

## Recreating the panel

The panel holds no content and no identities.

| State | After recreating the panel |
|---|---|
| Content | Never held by the panel |
| Users and logins | Held by the identity provider; unaffected. Editors, CLIs and agents sign in again |
| Signing key | A Worker secret: set the same one again, or a new one, which sites fetch from the same address |
| Site permissions | Held by sites, keyed by provider identity; unaffected |
| Shared site list | Lost; re-add sites by URL |
| Favorites | Lost |

## Sites without an org

A site works on its own too, the way a single site would: no hub, no `VIBE_ORG`. It then signs people in itself, with its own identity provider (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`) or, without one, passkeys. `VIBE_ORG` wins when both are set, so joining an org is one variable.

- **The first owner** comes from a one-time setup link the site prints to its logs while nobody owns it. Whoever opens it becomes the owner (`owner`, a built-in role with every permission plus managing users).
- **Everyone else is invited** by an owner, by email with roles, from the editor's Users page. With passkeys, the invite is a single-use link to create one, and inviting again replaces a lost passkey. Invites are emailed when the handler has an `email` sender (any `{ send(message) }`), and always shown as a link to copy.
- **Agents and the CLI** sign in to the site itself: it's an OAuth 2.1 server (the same `vibe-cms/oauth` core the hub runs, with its own tables and consent) (`{prefix}/oauth/*`, metadata under `/.well-known/oauth-*{prefix}`) whose consent screen is the editor, so whoever approves is already signed in. Access tokens carry no roles: each use works them out from the approver's identity, and a read-only connection can only read. The CLI logs in with a loopback redirect, or `--headless` with a code shown at `{prefix}/oauth/code`.
- **Sessions:** a signed-in browser holds an httpOnly, `SameSite=Lax` cookie that only `POST /api/session` reads, to hand the editor its usual 12-hour bearer token. Every other route stays bearer-only, so the cookie is no CSRF surface. Roles are worked out again on each trade, so changes apply at once.

## Moving a site to another org

Change the site's `VIBE_ORG` and redeploy. It fails safely: the old org's tokens stop working on the site, and the new org's hub can add it by URL. Changing the identity provider doesn't touch sites at all: it's the hub's `OIDC_*` settings.

## Moving the hub, renaming the org

**A new address** is a DNS change: point `_vibe-hub.<org>` at it. Register the new redirect URL at the identity provider first.

**A new org name** (`my-agency.com` → `new-agency.com`) needs each site to accept a move, without a redeploy:

1. The hub's `VIBE_ORG` changes. The hub notices, remembers its previous orgs, and keeps signing as the old org for each site that still trusts it, so nobody is locked out. It learns which org each site trusts from the site's descriptor.
2. From its cron (every five minutes), or `POST /api/org/moves`, the hub sends each site on a previous org a move token: `{ iss: old org, aud: site, scope: "org-move", to: new org }`, valid 15 minutes.
3. The site checks it against the keys it already has for its hub (fetched, or its stored copy if the old record or hub is gone), looks up the new org's hub, and requires that hub to serve the same key. A move can't point a site at a hub with other keys.
4. The site waits **72 hours** (`VIBE_ORG_MOVE_DELAY`) before trusting the new org. Its editor shows a banner the whole time; anyone who can change the site's settings can cancel. Asking again doesn't restart the clock.
5. When the delay is up, the site trusts the new org. If the hub signs for the old org once more, the site refuses, the hub reads its descriptor again and signs as the new org.

The waiting period is the protection against a stolen key. A key thief could otherwise move sites to an org they control, and replacing the hub's key wouldn't bring them back. With the delay, a move nobody asked for gets noticed and cancelled; a real rename can wait three days.

The site keeps its org in its database (`vibe_meta`), with a history of each change (`GET /_vibe/api/org`):

| Deploy | Org the site trusts |
|---|---|
| First deploy with `VIBE_ORG` | `VIBE_ORG` |
| Same `VIBE_ORG` after an accepted move | The moved-to org: the variable is stale, not a decision |
| `VIBE_ORG` changed to another value | The new value, and any pending move is dropped |
| `VIBE_ORG_RESET=1` | `VIBE_ORG` (or none), whatever moves it accepted |
| `VIBE_ORG` removed | The stored org, with a warning, so a lost variable never leaves a site without sign-in |

## Local development

`vite dev` serves the site's editor at `/_vibe/admin`. A local panel runs alongside it:

```sh
bunx vibe-cms admin
# → http://localhost:5173/?site=http://localhost:8787
```

A local panel avoids browser restrictions on public pages calling `localhost`, and works offline. Its site list is kept in `localStorage`. In dev, the local site skips token verification, so no identity provider is needed. The editor can also be opened directly at `http://localhost:8787/_vibe/admin` in development.

### Production-like local setup with portless

[portless](https://portless.sh/) is recommended (not required) when working on the panel, iframe and handoff with several sites at once. It gives each dev server a stable, named HTTPS URL through a local reverse proxy.

```sh
portless proxy start --tld test
portless panel bun run dev        # https://panel.test
portless client-a bun run dev     # https://client-a.test
portless client-b bun run dev     # https://client-b.test
```

Why it helps:

- **Cross-site behaves like production.** `localhost:5173` and `localhost:8787` are different origins but the *same site*, so cookie and iframe behavior differs from production, where the panel and each site are on different domains. `panel.test` and `client-a.test` are different sites, like production. (`.localhost` subdomains probably are too, but browsers special-case `localhost`, so `.test` is the safer choice.)
- **HTTPS everywhere.** Browsers treat `http://localhost` as secure inconsistently (e.g. `Secure` cookies in Safari vs. Chrome). Real HTTPS removes that class of browser-specific bugs.
- **Stable URLs.** The panel's site list stores URLs, and ports can change between runs; `client-a.test` doesn't. Fixed HTTPS names also suit identity providers that require HTTPS redirect URLs.

The design already avoids the worst iframe cookie problems (the embedded editor keeps its session in memory), so portless is about making bugs show up locally rather than making things work at all.

Caveats: portless is pre-1.0 (pin the version), needs Node 24+, and on first run binds port 443 and installs a local certificate authority (sudo on macOS and Linux). It works with Vite (including `@cloudflare/vite-plugin`); plain `wrangler dev` is unverified. `bunx vibe-cms admin` keeps working on plain ports without it.

## Shipping the panel

The panel is the same for every agency; only its settings differ. It is delivered as a **template repo**: an agency copies it, sets the environment variables, and deploys. The default target is a Cloudflare Worker with D1 for the site list and favorites. Other targets (Node, Docker) are not planned for now.

In the monorepo, the panel backend and its frontend are **one package**, `apps/panel`. It splits into two packages (e.g. `apps/panel-server` and `apps/panel-shell`) when an Electron shell needs the frontend without the server.

## Open questions

- **Session details:** site session lifetime and refresh, and the exact request and response shapes of the code endpoints.
- **Who can remove sites** from the shared list (any panel user, or only whoever added it).
- **Exporting and importing** the site list, so recreating a panel doesn't mean re-adding every site.
- **The permissions overhaul:** who assigns roles (config, a site's Users page, the hub) is due a redesign; the hub doesn't manage roles yet.
- **Simplifying agent sessions:** sites accept hub tokens as `Authorization: Bearer` directly, so the hub could send those instead of trading each for a cached site session (`agent_site_tokens`).
