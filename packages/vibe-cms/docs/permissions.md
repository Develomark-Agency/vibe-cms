# Permissions

How editors sign in to a deployed site (its org's hub, `VIBE_ORG`), how roles are assigned, and exactly what each role rule allows.

Roles are data, not config: each site stores its own in its database, edits them on the editor's **Roles** page, and checks them on every request. A fresh site has only the built-in `owner`; add roles from a preset or by hand.

```ts
// examples/schemas/src/permissions.ts
// What the Roles page stores for each role, and what `PUT /_vibe/api/roles/:name` and hub
// templates take: rules by content type, plus a few switches.
export const roles: Record<string, RoleRules> = {
  admin: { all: true },
  editor: {
    "*": ["read"],
    post: ["read", "write", "publish", "delete"],
    page: ["read", "write"],
    media: ["read", "write"],
    siteSettings: true
  },
  // Writes posts but can't publish them.
  contributor: { post: ["read", "write"], media: ["read", "write"], publish: false }
};
```

## Signing in

- **Development** (`dev`, which defaults to Vite's `import.meta.env.DEV`): the editor, the CLI and local agents sign in as a local developer with every permission. No `VIBE_ORG` or roles needed.
- **Deployed**: the site belongs to the org in its `VIBE_ORG` environment variable, and everyone signs in to that org's hub (the agency panel), which signs them in with its identity provider. Sign-in is the same for every site in the org, so it's deploy configuration, not part of the config file. For each site, the hub signs a short-lived token addressed to that site alone, issued by the org and carrying the provider identity (`<issuer>|<sub>`) and claims. The site finds the hub through the org's DNS record, checks the token against the hub's keys at `<hub>/.well-known/jwks.json`, works out roles itself, and creates its own session. A session the hub vouched for lasts 10 minutes and is renewed through the hub without a word to the user, so what the hub grants or takes away applies within minutes; it also ends as soon as the site trusts another org. Sites have no secrets to configure; the session signing key is generated and stored in D1. See `vibe-cms docs deploy` for orgs.
- The editor of a deployed site only opens inside the hub, which hands it a one-time code; on its own it links to the site's page in the hub (`<hub>/s/<site id>/`). The CLI logs in to the hub with `vibe-cms login` (`vibe-cms docs cli`), and agents connect to the hub's `/mcp` (`vibe-cms docs agents`).
- **Deployed without an org**: a site without `VIBE_ORG` signs people in itself (below).

## Sites without an org

A site that doesn't belong to an org signs people in by itself. Its environment picks how, and an org wins over both:

| Set | Sign-in |
|---|---|
| `VIBE_ORG` | The org's hub (above) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (a secret) | The site's own identity provider. Register `https://<site>/_vibe/api/auth/oidc/callback` as its redirect URI. Optional: `OIDC_SCOPES`, `OIDC_ROLES_CLAIM` (a claim whose values count as roles), `VIBE_ALLOW` (email domains or group values allowed to sign in) |
| Neither | Passkeys |

Setting only some of the `OIDC_*` variables is an error, not a quiet fall back to passkeys.

**The first owner.** Until someone owns the site, nobody can sign in. The site prints a one-time setup link to its logs (`wrangler tail`, or the dev server's output): `https://<site>/_vibe/admin/#setup=…`. Whoever opens it becomes the site's **owner**: with passkeys, by creating one; with an identity provider, by signing in through the link (with a verified email). Then the link stops working. Nobody becomes owner just by finding the site first.

**Inviting people.** Owners manage everyone else on the editor's **Users** page: invite by email with roles, change roles, remove people. With passkeys, an invite is a link that works once, for 7 days, to create a passkey; inviting someone again is how they add a device or replace a lost passkey. With an identity provider, roles are matched to the verified email people sign in with. If the site has an `email` sender (`vibe-cms docs getting-started`), invites are emailed; either way the editor shows the link to copy, so a site that can't send email, or an email that fails, never blocks an invite.

```ts
import type { EmailSender } from "vibe-cms/handler";

createHandler(config, {
  bindings: env => ({
    db: env.DB,
    // Cloudflare Email Service (a send_email binding), or any other provider's API
    email: {
      send: ({ to, subject, text, html }) => env.EMAIL.send({ to, from: "cms@client.com", subject, text, html }),
    } satisfies EmailSender,
  }),
});
```

`owner` is a built-in role: every permission, plus managing roles and users. On a site without an org only the site gives it (the setup link or the Users page); on an org site, the hub's signed `siteAdmin` claim does (below). A `roles` claim naming `owner`, from an identity provider or the hub, is always ignored. Owners and roles with `all: true` can manage roles and users; roles with `manageRoles: true` can too, within their own reach (below). A signed-in browser keeps an httpOnly cookie for 30 days, which the editor trades for a 12-hour session; signing out, or being removed, ends it. Agents and the CLI sign in to a site without an org the same way: the site's editor asks the signed-in user to approve them (`vibe-cms docs agents`, `vibe-cms docs cli`).

## Roles

Roles live in the site's database (`vibe_roles`), so dev, staging and production each have their own. Owners and roles with `all: true` edit them on the editor's **Roles** page: a rule builder per content type, languages, media, site settings and backups. Everyone else can't open it.

- **Presets.** "Add from preset" copies one of the packaged presets (Admin, Editor, Contributor, Translator) into the site's roles, with no link back. They're also exported from `vibe-cms/roles` as `PRESETS`.
- **Saving checks rules** against the site: keys must be content types it has (or the switches below), actions must be `read`, `write`, `publish` or `delete`, and locales must be the site's. A role that names a type the site no longer has keeps working; the rule is ignored, and the Roles page flags it.
- **Guardrails.** A change that would leave nobody able to manage the site is refused.
- **API** (under `/_vibe/api`, owners and `all` roles for writes): `GET /roles`, `PUT /roles/:name` (`{ rules }`), `DELETE /roles/:name`, `POST /roles/apply` (`{ roles: { name: rules }, replace? }`, what the hub's templates use; rules for missing types are skipped and reported), `GET /roles/presets`, `GET /roles/schema` (content types and locales).

A signed-in user's roles are the union of:

- on an org site, the `roles` the hub passes on: the roles the hub assigned them on this site, and the values of the identity provider claim named by the hub's `OIDC_ROLES_CLAIM` (for example `groups`), if it sets one;
- on a site without an org, the roles given on the editor's **Users** page.

Only the site's stored roles and the built-in `owner` count; other names are ignored and never widen access. A user with none gets "No access to this site".

**Site admins from the hub.** The hub's owner and admins, and whoever added the site to the hub (or was made its owner there), manage the site. The hub says so with a `siteAdmin: true` claim it signs into the token, and the site makes them `owner` for that session. It's never stored on the site and can't be removed there; the site's 10-minute sessions mean it's checked with the hub again within minutes, and it ends at once if the site stops trusting that org. On org sites the **Users** page asks the panel the editor runs in who has which role there, and changes it through the panel, with the signed-in person's own rights on the hub: the same list as the site's **People and roles** page in the hub.

**Managing roles within your own.** A role with `manageRoles: true` ("Manage roles" on the Roles page) may create, change, delete and give out roles, but only roles that stay within what that person's own roles allow: no action on a type, media, language, site settings or backups they don't have themselves, never `all`, and never `owner`. Roles beyond their reach show read only, and so do people who hold them. On org sites the hub applies the same rule when they give people roles from the Users page. Templates (`POST /roles/apply`) stay owners-only.

**Upgrading.** A config that still has `permissions.roles` has them copied into the database once, on the first request (names already stored are skipped), with a warning in the logs to remove the key. `permissions.users` is honored for one more release, only for people nothing else gives a role. Remove `permissions` from your config once the roles are on the site.

## Role rules

A role is an object of rules; a user may do anything any of their roles allows.

| Rule | Allows |
|---|---|
| `all: true` | Everything, including media and site settings |
| `"<type>": [...]` | Actions on that content type: `"read"`, `"write"`, `"publish"`, `"delete"` |
| `"*": [...]` | The same, for every type without its own rule. A type's own rule replaces `"*"` rather than adding to it. |
| `publish: false` | Turns publishing (and scheduling) off for every type. Otherwise a type is published only when its rule lists `"publish"`. (`publish: true` keeps the old meaning, where `write` implied publishing; config roles are rewritten in today's terms when they're copied onto the site.) |
| `write: { locales: [...] }` | Writing every type the role can read, but only in these locales: a translator. Also limits the role's other writes to these locales. |
| `media: [...]` | The media library. Without it: read always, upload (`write`) if the role may write any type, delete never. |
| `siteSettings: true` | Changing the site's name, accent and icon (`vibe-cms docs config`). Not implied by anything but `all`. |
| `backups: "take"` | Taking snapshots (`vibe-cms docs backups`), which reads every draft and file. Not implied by anything but `all`. |
| `backups: true` | Taking and restoring them. A restore replaces everything. |
| `manageRoles: true` | Creating, changing and giving out roles up to the person's own access (above). |

Details that matter:

- Listing any action for a type also allows reading it. The Roles page shows each type (and the media library) as a level that includes the ones before it, No access › Read › Write › Publish (or Upload for media), with Delete as its own checkbox.
- `delete` is never implied; list it explicitly.
- Rules are checked on the site for every request, whether it comes from the editor, the CLI, MCP or the panel's agents.
- Rules naming content types the site doesn't have are ignored at runtime and refused when saving.

## Checking access from code

Plugin hooks and routes receive the request's `session` (`{ sub, email, name, roles }`, or `null` for public requests); see `vibe-cms docs server-hooks`. In-process clients (`vibe.client(env)`, a plugin's `ctx.cms`) are trusted and skip permission checks.
