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

The panel never loads a site's code into its own page. It shows the site's editor in a cross-origin **iframe** inside the panel's frame, or sends you to it as a full page.

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

## Sites trust an OIDC issuer

A site's config names one OIDC issuer and the panel's client ID at that provider. The site learns everything else (public keys, endpoints) through OIDC discovery at `<issuer>/.well-known/openid-configuration`, fetched at runtime and never stored at deploy time.

```ts
// vibe-cms.config.ts (site)
import { defineConfig } from "vibe-cms";
import { oidc } from "vibe-cms/auth";

export default defineConfig({
  auth: oidc({
    issuer: "https://accounts.google.com",
    clientId: "1234.apps.googleusercontent.com", // the panel's client ID; expected `aud`
    roles: "groups",                              // optional: claim to read roles from
  }),
  schemas: { /* … */ },
});
```

Every site trusts **exactly one** issuer and client ID.

## Permissions live on the site

Anyone allowed into the panel sees every site in the shared list. Whether they can do anything on a site is decided by that site alone.

```ts
// vibe-cms.config.ts (site)
export default defineConfig({
  auth: oidc({ issuer: "https://accounts.google.com", clientId: "1234.apps.googleusercontent.com" }),
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

- Roles come from the identity provider's claims (`roles: "groups"` for Okta, Entra, Keycloak, …), from `permissions.users`, or both.
- Users keyed by email require the `email_verified` claim.
- Site permissions and version history key on stable provider identity, never on anything panel-specific, so they survive the panel being recreated.

## Signing in

The panel's backend is the OIDC client (the "backend for frontend" pattern). It runs the provider's login flow, keeps the provider's tokens server-side, and gives the browser an httpOnly session cookie for the panel only. Browser code never sees a provider token.

## Opening a site: the one-time code handoff

```
panel backend ──POST /_vibe/api/session/code (provider ID token)──▶ site-40
                                        verifies via discovery, checks iss / aud / exp,
                                        maps identity → roles
              ◀──────────── one-time code (single use, ~30s) ─────────────
panel ──code──▶ site-40's editor ──POST /_vibe/api/session (code)──▶ site-40
                                 ◀──────── site session token ───────────
```

1. The panel backend sends the provider's ID token to the site, server to server.
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

### Two ways the code arrives

The editor is the same standalone app either way; only the delivery differs.

| Mode | How the code arrives | Session kept in |
|---|---|---|
| **Embedded** (default) | `postMessage` from the panel, addressed only to the site's origin | Memory |
| **Full page** ("open in new tab", or a bookmark) | Redirect to `/_vibe/admin#code=…`; the fragment never reaches a server, and the editor strips it from the URL | httpOnly first-party cookie |

The embedded session lives **in memory**, not in a cookie:

- Browsers block or partition cookies in cross-site iframes (Safari most strictly), so memory is the reliable option.
- It makes clickjacking moot: if any other website frames the editor, the editor has no session there, so there is nothing to trick a user into doing.
- If the iframe reloads, the editor asks the panel for a fresh code.

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

The site dropdown lives in the panel frame. Switching swaps the iframe to the other site and runs a fresh handoff. In full-page mode, the editor shows a link back to the panel; `edit.my-agency.com/go/<siteId>` runs the handoff and redirects, without logging in again.

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
```

`PANEL_ALLOW` matters for providers like plain Google, where anyone with an account can sign in. Cloudflare Access can enforce this before requests reach the panel.

### The shared site list and favorites

When you first log in, there are no sites. Sites are added by URL, and the list is **shared by everyone using that panel**: one panel deployment is effectively one agency. Each user can favorite sites on top of that.

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
  "auth": {
    "issuer": "https://accounts.google.com",
    "clientId": "1234.apps.googleusercontent.com"
  },
  "admin": "https://site-40.com/_vibe/admin"
}
```

You paste a URL into the panel. The panel fetches the descriptor and adds the site only if `auth.issuer` and `auth.clientId` match its own settings. Otherwise it refuses: "This site trusts a different identity provider."

No secret is needed: the panel isn't proving who *owns* the site, only that the site *agreed* to trust the same identity provider and panel client. Only someone who controls the site's deployment can make that file say so, the same principle as file-based domain verification.

## Security model

**Browser side: isolated.** Each site's editor runs on its own origin. A malicious or compromised plugin, widget or dependency on site 12 can act on site 12 (plugins are trusted code), but cannot touch the panel's page, the panel's session, or any other site. Provider tokens never reach the browser.

**Server side: one remaining gap.** During the handoff, every site receives the provider's ID token, and its audience is the panel's client ID, so every site that trusts the same issuer would accept it. A compromised plugin's *server* code on site 12 could capture those tokens and replay them to another site's handoff endpoint while they are valid (about an hour for Google). Closing this needs tokens that only work on one site; providers with audience-specific access tokens (Auth0, Okta, Entra) can provide them, plain Google can't. Until then, this part assumes an agency's sites are one trust domain.

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
| Users and logins | Held by the identity provider; unaffected |
| Site permissions | Held by sites, keyed by provider identity; unaffected |
| Shared site list | Lost; re-add sites by URL |
| Favorites | Lost |

## Moving a site to another identity provider

Change `auth:` in the site's repo and redeploy. It fails safely: panels using the old provider can no longer hand off to the site, and panels using the new provider can add it by URL.

## Local development

`vite dev` serves the site's editor at `/_vibe/admin`. A local panel runs alongside it:

```sh
bunx vibe-cms admin
# → http://localhost:5173/?site=http://localhost:8787
```

A local panel avoids browser restrictions on public pages calling `localhost`, and works offline. Its site list is kept in `localStorage`. In dev, the local site skips token verification, so no identity provider is needed. The editor can also be opened directly at `http://localhost:8787/_vibe/admin`.

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
- **Expired sessions in full-page mode:** the site trusts a provider, not a panel, so it doesn't know where to send someone to log in. Options: remember the panel that handed you in, or an optional login URL in the site config.
- **Who can remove sites** from the shared list (any panel user, or only whoever added it).
- **Exporting and importing** the site list, so recreating a panel doesn't mean re-adding every site.
- **Closing the server-side gap** with per-site tokens where providers support them.
