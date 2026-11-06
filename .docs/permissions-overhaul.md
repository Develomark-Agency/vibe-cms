# Permissions overhaul

Plan for moving users, roles and permissions out of code config and into data, and for giving the org hub a real notion of who administers what. Supersedes the open "permissions overhaul" item in `panel-and-auth.md`. Built through step 6; step 7 is partly done: `permissions` is deprecated and imported, not yet rejected (see Migration).

## Decisions

1. **Users are never in code.** `permissions.users` is removed.
2. **Roles are data owned by the site.** They live in the site's D1 and are edited in the site's editor. The site enforces them on every request, as today, with no dependency on the hub being reachable.
3. **No roles in code at all.** `permissions` is removed from `defineConfig`. A fresh site has only the built-in `owner`. <span style="white-space: nowrap">Vibe CMS</span> ships **presets** (Admin, Editor, Contributor, Translator) inside the package: starting points, not live roles. Adding one copies it into the site's stored roles with no link back.
4. **The hub manages its own admins and members.** The first admin comes from a printed one-time setup link, never from "first to sign in".
5. **The hub assigns roles to users per site** and signs the role names into the site token. The site resolves them against its own stored roles.
6. **Site authority is a signed per-site grant.** The user who added a site, the org owner and org admins may manage that site's roles and users. The hub signs this as a claim of its own; an identity provider group named `owner` still counts for nothing.
7. **Templates are copied, not linked.** A hub template of roles is written onto a site when the site is added. Re-applying is explicit.

## Today (what we're changing)

- **Hub:** every user who passes `PANEL_ALLOW` is equal. Sessions hold `sub`, `email` and `name` only. The shared site list is visible to, and addable by, everyone. The only role input to sites is the IdP claim named by `OIDC_ROLES_CLAIM`.
- **Site:** `identitySession` ([auth.ts](../packages/vibe-cms/src/handler/auth.ts)) builds roles from the token's `roles` claim, `permissions.users` and, on sites without an org, stored roles from the Users page. Role names outside `permissions.roles` and `owner` are dropped. `can()` checks rules from the code config.
- **Users page:** exists only for sites that sign people in themselves; org sites cannot manage users at all.

## Design

### Hub: members, roles, bootstrap

New tables in `apps/panel/src/server/schema.ts`:

| Table | Purpose |
|---|---|
| `members` | `sub` (`<issuer>\|<sub>`), `email`, `name`, `role` (`owner`, `admin`, or a custom hub role name), `added_by`, `added_at` |
| `hub_roles` | `name`, `permissions` (JSON). Built-ins `owner` and `admin` are not stored |
| `site_grants` | `site_id`, `sub`, kind (`owner`), `granted_by`, `granted_at`: who may manage that site's roles and users |
| `site_assignments` | `site_id`, `sub` or verified email, `roles` (JSON array of site role names): the hub's user→role assignments |
| `templates` | `id`, `name`, `roles` (JSON, same shape as a site's stored roles), `is_default` |

**Hub permissions**, held by roles: `members` (invite, change roles, remove), `roles` (create and edit hub roles), `templates` (create, edit, delete), `addSites`, `removeSites`. Below owner and admin, `members` and `roles` only reach as far as the holder's own permissions. `owner` has all and cannot be removed or demoted by anyone else; `admin` has all but cannot touch the owner.

**Bootstrap.** Until the hub has an owner, it prints a one-time setup link to its logs, same pattern as `announceSetup` on sites ([signin.ts](../packages/vibe-cms/src/handler/signin.ts)): a random token in `panel_meta`, shown as `https://<hub>/#setup=<token>`. Whoever opens it and signs in through the identity provider becomes `owner`; the token is then deleted. `PANEL_ALLOW` still applies. Until an owner exists, nobody else can sign in.

**Members.** Signing in no longer implies membership beyond passing `PANEL_ALLOW`:
- A user who passes `PANEL_ALLOW` but has no member row can sign in and sees nothing, unless they hold a site assignment.
- Admins invite people (by verified email) with a hub role, or assign them to a site directly. Assignment by email resolves to `sub` at first sign-in.

**Site list visibility.** The list shows only sites where the user is a hub owner/admin, holds a `site_grants` row, or has a `site_assignments` row. Add and remove are permissions (`addSites`, `removeSites`), and the adder may remove their own site.

### Hub → site token

The token already carries `roles` from the IdP claim. It gains:

- `roles`: the union of the IdP claim values (as today) and the user's `site_assignments` for this site.
- `siteAdmin: true`: set when the user is a hub owner or admin, or has a `site_grants` row for this site. Signed by the hub, scoped by the token's existing `aud`.

`PROVIDER_ONLY` in `hub.ts` already strips a provider-supplied `roles`; add `siteAdmin` to it so a provider claim can never forge it.

### Site: stored roles, grant, role API

**Storage.** A `vibe_roles` table in the site's D1 (`name`, `rules` JSON, `updated_by`, `updated_at`) is the only source of roles, besides the built-in `owner`. Nothing is written at deploy.

**Presets.** The package exports a small list of presets (Admin, Editor, Contributor, Translator) as plain rule objects. The Roles page has "Add from preset", which copies one into `vibe_roles`; presets that name types the site lacks are trimmed and reported, like templates. On a standalone site, the setup flow offers presets to the first owner. Hub templates (below) start from the same presets.

**Resolution** (`identitySession` and `can`):
- `can()` reads stored roles from state instead of `config.permissions.roles`. Cache per request/isolate with invalidation on role writes.
- A token with `siteAdmin: true` yields the built-in `owner` for that request, but only from a verified hub token for a site in an org. It is never stored and cannot be removed on the site; sessions the hub vouched for last 10 minutes and renew through the hub, and end when the site stops trusting the org. This is a deliberate exception to "hub tokens naming `owner` are ignored"; the exception is the new signed claim, not the `roles` claim, which keeps filtering `owner`.
- Unknown role names (from the hub, or a role referencing a deleted content type) are ignored and never widen access.

**API** (new, under `/_vibe/api`, all requiring the `users`/roles permission):
- `GET /roles`, `PUT /roles/:name`, `DELETE /roles/:name`, `GET /roles/presets`, `GET /roles/schema` (content types and locales, for the editor's rule builder).
- Validation on save: rule keys must name existing types and locales; unknown keys are rejected with a clear error. At runtime they are ignored and flagged in the editor.
- Guardrails: owners, `all: true` roles and `siteAdmin` may edit anything; `manageRoles: true` roles only roles within their own reach (`beyondReach` in `roles.ts`); a save may not leave the site with nobody able to manage it.
- The Users page extends to org sites: the editor asks the panel it runs in (`vibe:hub` messages) for the hub's assignments, and changes them through it.

**Editor UI.** A Roles page (list, rule builder per type, locales, media, `siteSettings`, `backups`) next to Users.

### Templates

- Hub users with the `templates` permission create and edit templates: named sets of roles with rules.
- Adding a site picks a template (the default is preselected, or "none"). After the descriptor check, the hub calls the new site's role API with a short-lived `siteAdmin` token and writes the rows.
- Rules for content types the site lacks are skipped and reported ("2 rules skipped: `homepage` doesn't exist on this site"). The apply never fails wholesale for that.
- If the site is unreachable, the apply is recorded as `pending` and retried, visible in the site's row.
- "Apply template" on an existing site is explicit, shows a diff against its current roles, and asks before overwriting.
- "No roles" is a valid choice: the site starts with owners only, and roles are added later from presets or by hand.

### Migration

- On first request after upgrade, a site whose config still has `permissions.roles` writes those roles into `vibe_roles` once (skipping names already stored) and logs a warning to remove the key. `permissions.users` entries are honored for one release as a fallback only if nothing else assigns that identity, then removed. After that, `defineConfig` rejects `permissions`.
- Sites without an org keep their setup link and Users page unchanged; they also gain the Roles page.
- Hub: existing panels have no owner. The setup link is printed on upgrade until someone claims it. Existing users who already hold sessions keep them but have no member row until claimed.

## Build order

1. **Site: roles as data.** `vibe_roles` table, role resolution in `can()`/`identitySession`, role API with validation and guardrails, packaged presets, one-time import of config roles. Works for standalone sites immediately. Tests alongside `handler.test.ts` and `types.test.ts`.
2. **Site: Roles page in the editor.**
3. **Hub: members and bootstrap.** Schema and migration, printed setup link, member invites, hub roles and permissions.
4. **Hub → site: assignments and `siteAdmin`.** `site_assignments`, `site_grants`, token claims, the site accepting `siteAdmin`, panel UI to assign roles from the site's role list (fetched via `GET /roles`).
5. **Hub: site list visibility and add/remove permissions.**
6. **Hub: templates** and apply-on-add, with pending/retry.
7. **Remove `permissions` from `defineConfig`** and update `permissions.md`, `deploy.md`, `panel-and-auth.md`, `agents.md`.

Steps 1 and 3 can proceed independently; 4 needs both.

## Open questions

- **Keeping environments in sync.** With no roles in code, dev, staging and production each hold their own. Does a team need export/import of roles (a JSON file or CLI command)? Deferred; hub templates cover the agency case.
- Should a hub member with only site assignments be able to see other sites' names in the list? (Plan: no.)
- Should `site_grants` be transferable by the adder, or only by hub admins?
- Where do template edits that conflict with a site's custom role of the same name land: overwrite, skip, or prompt? (Plan: prompt on explicit apply; on add, there is nothing to conflict with.)
- Should the hub list a site's stored roles in its own UI for admins, or only offer them as pickers when assigning?
