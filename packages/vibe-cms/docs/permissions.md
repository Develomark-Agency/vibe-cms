# Permissions

How editors sign in to a deployed site (its org's hub, `VIBE_ORG`), how roles are assigned, and exactly what each role rule allows.

```ts
// examples/schemas/src/permissions.ts
// Editors, the CLI and agents sign in through the org's hub (panel): deploy the site with
// VIBE_ORG=my-agency.com. Sign-in is the org's choice, so nothing about it lives in this file.
// Development sites don't need it.
export default defineConfig({
  permissions: {
    roles: {
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
    },
    // Roles by verified email (or `<issuer>|<sub>`), on top of any the hub passes on from the
    // identity provider (its OIDC_ROLES_CLAIM, e.g. "groups").
    users: {
      "ada@agency.example": ["admin"],
      "sam@client.example": ["editor"]
    }
  },
```

## Signing in

- **Development** (`dev`, which defaults to Vite's `import.meta.env.DEV`): the editor, the CLI and local agents sign in as a local developer with every permission. No `VIBE_ORG` or `permissions` needed.
- **Deployed**: the site belongs to the org in its `VIBE_ORG` environment variable, and everyone signs in to that org's hub (the agency panel), which signs them in with its identity provider. Sign-in is the same for every site in the org, so it's deploy configuration, not part of the config file. For each site, the hub signs a short-lived token addressed to that site alone, issued by the org and carrying the provider identity (`<issuer>|<sub>`) and claims. The site finds the hub through the org's DNS record, checks the token against the hub's keys at `<hub>/.well-known/jwks.json`, works out roles itself, and creates its own session, valid for 12 hours. Sites have no secrets to configure; the session signing key is generated and stored in D1. See `vibe-cms docs deploy` for orgs.
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

`owner` is a built-in role: every permission, plus managing users. Only the site gives it (the setup link, the Users page, or `permissions.users`); an identity provider claim or hub token naming `owner` is ignored. Owners and roles with `all: true` can manage users. A signed-in browser keeps an httpOnly cookie for 30 days, which the editor trades for a 12-hour session; signing out, or being removed, ends it. Agents and the CLI sign in to a site without an org the same way: the site's editor asks the signed-in user to approve them (`vibe-cms docs agents`, `vibe-cms docs cli`).

## Roles

A signed-in user's roles are the union of:

- the `roles` the hub passes on: the values of the identity provider claim named by the hub's `OIDC_ROLES_CLAIM` (for example `groups`), if it sets one, and
- `permissions.users` entries matching their verified email (lowercased) or `<issuer>|<sub>`, and
- on a site without an org, the roles given on the editor's **Users** page.

Only roles defined in `permissions.roles`, and the built-in `owner`, count. A user with none gets "No access to this site".

## Role rules

A role is an object of rules; a user may do anything any of their roles allows.

| Rule | Allows |
|---|---|
| `all: true` | Everything, including media and site settings |
| `"<type>": [...]` | Actions on that content type: `"read"`, `"write"`, `"publish"`, `"delete"` |
| `"*": [...]` | The same, for every type without its own rule. A type's own rule replaces `"*"` rather than adding to it. |
| `publish: boolean` | Overrides publishing (and scheduling) for the role's types. Without it, any type the role may `write` (or `publish`) it may publish. |
| `write: { locales: [...] }` | Writing every type the role can read, but only in these locales: a translator. Also limits the role's other writes to these locales. |
| `media: [...]` | The media library. Without it: read always, upload (`write`) if the role may write any type, delete never. |
| `siteSettings: true` | Changing the site's name, accent and icon (`vibe-cms docs config`). Not implied by anything but `all`. |
| `backups: true` | Taking and restoring snapshots (`vibe-cms docs backups`). Reads every draft and file, and a restore replaces them all. Not implied by anything but `all`. |

Details that matter:

- Listing any action for a type also allows reading it.
- `delete` is never implied; list it explicitly.
- Rules are checked on the site for every request, whether it comes from the editor, the CLI, MCP or the panel's agents.
- `defineConfig` type-checks rule keys against your content types and locales, and `users` role names against `roles`.

## Checking access from code

Plugin hooks and routes receive the request's `session` (`{ sub, email, name, roles }`, or `null` for public requests); see `vibe-cms docs server-hooks`. In-process clients (`vibe.client(env)`, a plugin's `ctx.cms`) are trusted and skip permission checks.
