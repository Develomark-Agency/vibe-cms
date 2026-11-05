# Deploying

Put a vibe-cms site on Cloudflare: create the D1 database and R2 bucket, keep the cron trigger, build so the editor is in the static assets, and set up sign-in through your org's hub (`VIBE_ORG`).

## Checklist

1. **Create the resources.** vibe-cms never provisions anything.

   ```sh
   bunx wrangler d1 create my-site
   bunx wrangler r2 bucket create my-site-media
   ```

   Put the database ID in `wrangler.jsonc` (`d1_databases[].database_id`) and the bucket name in `r2_buckets[].bucket_name`. The CMS creates its tables (all prefixed `vibe_`, so it can share a database with your own tables) on the first request each isolate handles.

2. **Keep the cron trigger.** `"triggers": { "crons": ["* * * * *"] }` runs scheduled publishing and unpublishing, and purges the trash after `trash.days` (default 30). Without it, schedules never fire and the trash is only emptied by hand. Plugin cron jobs run only on schedules that are also triggers on the Worker.

3. **Keep the assets binding.** The editor is static files under `/_vibe/admin/`. The CMS serves its deep links (`/_vibe/admin/documents/post`) through the assets binding: `env.ASSETS`, or whatever you pass as `bindings.assets`.

4. **Set up sign-in.** Production sites have no dev sign-in and no password form: everyone signs in to your org's hub (the agency panel), which signs them in with your identity provider and vouches for them to each site. Set one environment variable on the site, the same for every site in the org:

   ```jsonc
   // wrangler.jsonc
   "vars": { "VIBE_ORG": "my-agency.com" }
   ```

   Or leave `VIBE_ORG` out and attach the site afterwards: it logs a claim link, and `vibe-cms admin attach <link>` (or pasting the link in the panel's **Add a site** box) tells it which org it belongs to (`vibe-cms docs cli`).

   The site finds the hub through the org's DNS record (see [Orgs](#orgs)) and accepts tokens issued by the org for this site, checked against the hub's keys at `/.well-known/jwks.json`. Who may do what is the site's own roles, edited on its Roles page; the hub assigns them to people per site (`vibe-cms docs permissions`).

5. **Build and deploy.**

   | Setup | Build | Deploy |
   |---|---|---|
   | Vite + `@cloudflare/vite-plugin` | `vite build` | `wrangler deploy` |
   | Astro + `@astrojs/cloudflare` | `astro build` | `wrangler deploy` |
   | Wrangler only | `vibe-cms build-admin --out <assets dir>/_vibe/admin` | `wrangler deploy` |

   The Vite builds write `.wrangler/deploy/config.json`, which points `wrangler deploy` at the generated `dist/…/wrangler.json`. Check that the client output contains `_vibe/admin/index.html` before deploying.

## Panel and site on workers.dev

Cloudflare doesn't let one Worker call another Worker's `workers.dev` address in the same account, and the panel and its sites call each other (the panel reads the site's descriptor and signs people in to it; the site fetches the panel's keys). Without help, adding a site fails with Cloudflare's error 1042, and the panel says so. Add the `global_fetch_strictly_public` compatibility flag to **both** the panel and the site and deploy them again:

```jsonc
// wrangler.jsonc (Alchemy: compatibilityFlags)
"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"]
```

`vibe-cms admin deploy` sets it on the panel. Custom domains (not routes) and service bindings avoid the limit too, so a site on its own domain doesn't need it.

## After deploying

- `https://<site>/.well-known/vibe-cms` describes the site to panels: id, name, accent, icon, its org and hub, a pending org move, and the editor's URL.
- The editor only opens inside the hub. `https://<site>/_vibe/admin/` on its own links to the site's page in the hub.
- Add the site to the hub by its URL, or paste its claim link if it was deployed without `VIBE_ORG`; the hub checks the site belongs to its org, makes you the site's owner, and writes its starting roles from a template if you pick one. Then give people roles on it under **People and roles**. Running a hub needs its own D1 database, OIDC client and signing key, which `vibe-cms admin deploy` sets up (or by hand: `apps/panel` in the vibe-cms repository); for local work, `bunx vibe-cms admin` runs a panel without an identity provider.
- Agents connect to the panel's `/mcp`, not to each site (`vibe-cms docs agents`).
- To move content you made locally onto the deployed site, export it and import it there: `vibe-cms export --site http://localhost:4321`, then `vibe-cms login <org>` and `vibe-cms import <file>.vibe --site https://…`. For copies kept outside Cloudflare on a schedule, use the panel's backups. Both are in `vibe-cms docs backups`.

## Orgs

An org is a domain you own that names your agency, like `my-agency.com`. It doesn't have to host anything. Sites trust the org, not the hub's address, so the hub can move without touching any site.

1. **Pick the domain.** Your agency's own domain is fine.
2. **Deploy the hub.** `bunx vibe-cms admin deploy` walks through it (`vibe-cms docs cli`): the database, sign-in, a custom domain, the signing key and the setup link. By hand, deploy `apps/panel` with `VIBE_ORG=my-agency.com` and its signing key (`bunx vibe-cms hub keygen | wrangler secret put HUB_SIGNING_KEY`).
3. **Add a DNS record** that points the org at the hub:

   ```
   _vibe-hub.my-agency.com   TXT   "https://admin.my-agency.com"
   ```

4. **Deploy sites with `VIBE_ORG=my-agency.com`**, then add each to the hub by its URL. The hub checks the site's descriptor names its org.

To **move the hub to another address**: add the new redirect URL at your identity provider, deploy the hub there, and change the TXT record. Sites look the record up again within its TTL (one minute to an hour); nothing is redeployed.

To **rename the org** (say `my-agency.com` → `new-agency.com`): add `_vibe-hub.new-agency.com`, set the hub's `VIBE_ORG` to the new name and deploy it. The hub remembers its previous orgs and asks each site to move, signed with its key. A site checks the move against the hub's keys it already has, and that the new org's hub serves the same key, then waits **72 hours** (`VIBE_ORG_MOVE_DELAY`, in seconds, changes it) before it trusts the new org. Meanwhile its editor shows a banner, anyone who can change the site's settings can cancel the move, and the hub keeps signing for the old org so nobody is locked out. A real rename can wait three days; a move nobody asked for gets noticed.

`VIBE_ORG` and accepted moves:

- Once a site accepts a move, the stored org wins over the unchanged `VIBE_ORG` value, so you can update the variable at your next deploy.
- Changing `VIBE_ORG` to a different value puts the variable back in charge, as does `VIBE_ORG_RESET=1`.
- Removing `VIBE_ORG` keeps the stored org, with a warning, rather than leaving the site with no sign-in. Set `VIBE_ORG_RESET=1` without `VIBE_ORG` to sign the site out of its org.
- `VIBE_ORG` may also be a URL (`https://admin.my-agency.com`): the hub is then that address, with no DNS lookup. That suits local setups, but the address can't change without redeploying sites.

Each site keeps a copy of its hub's public keys in its database, so it keeps checking tokens, and moves, when the DNS record or the old hub is already gone. Its org history (set, move requested, cancelled, moved) is at `GET /_vibe/api/org` for users who can change the site's settings.

## Environments

`dev` must be false in production, and is unless you set it: it defaults to `import.meta.env.DEV`, which Vite sets only for `vite dev`. A site with `dev: true` lets anyone sign in with every permission.
