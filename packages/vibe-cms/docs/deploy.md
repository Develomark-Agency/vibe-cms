# Deploying

Put a vibe-cms site on Cloudflare: create the D1 database and R2 bucket, keep the cron trigger, build so the editor is in the static assets, and set up sign-in through `auth: hub(...)` and an agency panel.

## Checklist

1. **Create the resources.** vibe-cms never provisions anything.

   ```sh
   bunx wrangler d1 create my-site
   bunx wrangler r2 bucket create my-site-media
   ```

   Put the database ID in `wrangler.jsonc` (`d1_databases[].database_id`) and the bucket name in `r2_buckets[].bucket_name`. The CMS creates its tables (all prefixed `vibe_`, so it can share a database with your own tables) on the first request each isolate handles.

2. **Keep the cron trigger.** `"triggers": { "crons": ["* * * * *"] }` runs scheduled publishing and unpublishing, and purges the trash after `trash.days` (default 30). Without it, schedules never fire and the trash is only emptied by hand. Plugin cron jobs run only on schedules that are also triggers on the Worker.

3. **Keep the assets binding.** The editor is static files under `/_vibe/admin/`. The CMS serves its deep links (`/_vibe/admin/documents/post`) through the assets binding: `env.ASSETS`, or whatever you pass as `bindings.assets`.

4. **Set up sign-in.** Production sites have no dev sign-in and no password form: everyone signs in to the agency panel (the hub), which signs them in with your identity provider and vouches for them to each site.

   ```ts
   import { hub } from "vibe-cms/auth";

   auth: hub({ url: "https://edit.my-agency.com" })
   ```

   The site accepts tokens that hub signed for this site, checked against its keys at `/.well-known/jwks.json`; `roles` names an identity provider claim to read roles from (for example `"groups"`). Who may do what is the config's `permissions` (`vibe-cms docs permissions`). Give the site a stable `id` in the config so the panel keeps recognising it if its hostname changes.

5. **Build and deploy.**

   | Setup | Build | Deploy |
   |---|---|---|
   | Vite + `@cloudflare/vite-plugin` | `vite build` | `wrangler deploy` |
   | Astro + `@astrojs/cloudflare` | `astro build` | `wrangler deploy` |
   | Wrangler only | `vibe-cms build-admin --out <assets dir>/_vibe/admin` | `wrangler deploy` |

   The Vite builds write `.wrangler/deploy/config.json`, which points `wrangler deploy` at the generated `dist/…/wrangler.json`. Check that the client output contains `_vibe/admin/index.html` before deploying.

## After deploying

- `https://<site>/.well-known/vibe-cms` describes the site to panels: id, name, accent, icon, its hub, and the editor's URL.
- The editor only opens inside the hub. `https://<site>/_vibe/admin/` on its own links to the site's page in the hub.
- Add the site to the hub by its URL; the hub checks the site trusts it. Running a hub (`apps/panel` in the vibe-cms repository) needs its own D1 database and OIDC client; for local work, `bunx vibe-cms admin` runs a panel without an identity provider.
- Agents connect to the panel's `/mcp`, not to each site (`vibe-cms docs agents`).
- To move content you made locally onto the deployed site, export it and import it there: `vibe-cms export --site http://localhost:4321`, then `vibe-cms login <hub>` and `vibe-cms import <file>.vibe --site https://…`. For copies kept outside Cloudflare on a schedule, use the panel's backups. Both are in `vibe-cms docs backups`.

## Environments

`dev` must be false in production, and is unless you set it: it defaults to `import.meta.env.DEV`, which Vite sets only for `vite dev`. A site with `dev: true` lets anyone sign in with every permission.
