# Permissions

How editors sign in to a deployed site (`oidc()`), how roles are assigned, and exactly what each role rule allows.

```ts
// examples/schemas/src/permissions.ts
export default defineConfig({
  // Editors sign in through the agency panel with this identity provider. Development sites don't need it.
  auth: oidc({
    issuer: "https://accounts.google.com",
    clientId: "1234.apps.googleusercontent.com",
    // Optional: read roles from this ID token claim as well.
    roles: "groups"
  }),
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
    // Roles by verified email (or `<issuer>|<sub>`), on top of any from the `roles` claim.
    users: {
      "ada@agency.example": ["admin"],
      "sam@client.example": ["editor"]
    }
  },
```

## Signing in

- **Development** (`dev`, which defaults to Vite's `import.meta.env.DEV`): the editor, the CLI and local agents sign in as a local developer with every permission. No `auth` or `permissions` needed.
- **Deployed**: editors sign in to the agency panel with the identity provider in `auth`, and the panel hands each site a one-time code. The site verifies the user's ID token against `issuer` and `clientId` (the panel's client ID at the provider) and creates its own session, valid for 12 hours. Sites have no secrets to configure; the session signing key is generated and stored in D1.
- A site without `auth` can't be signed in to once deployed. See `vibe-cms docs deploy` for the panel.

## Roles

A signed-in user's roles are the union of:

- the values of the ID token claim named by `auth.roles` (a string or array), if set, and
- `permissions.users` entries matching their verified email (lowercased) or `<issuer>|<sub>`.

Only roles defined in `permissions.roles` count. A user with none gets "No access to this site".

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
