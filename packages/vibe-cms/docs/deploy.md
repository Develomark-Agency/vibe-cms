# Deploying

Deploy an agency panel and a site on Cloudflare, connect them, and move your content across: what you need first, then the steps in order.

## What you're setting up

- **The panel** is one Worker per agency. People sign in to it with your identity provider, and every site's editor opens inside it.
- **A site** is one Worker per client: the site itself, its content API and the editor's files.
- **The org** is the name sites use to find their panel. It's either a domain you own (one DNS record points it at the panel) or simply the panel's own address.

## Before you start

- **Bun.** The CLI runs on Bun: `bunx vibe-cms …`.
- **A Cloudflare login for `wrangler`.** Run `bunx wrangler login` as the account that will own the panel and the sites (`bunx wrangler whoami` shows who you are). It needs permission for Workers, D1 and R2. To let the wizard attach a custom domain or add the org's DNS record it also needs DNS access on that domain's zone; without it, the wizard prints what to add instead. With several accounts, the wizard asks which one (or set `CLOUDFLARE_ACCOUNT_ID`).
- **An OpenID Connect identity provider.** People sign in to the panel through it. Any OIDC provider works: Google, Okta, Microsoft Entra, Auth0, Keycloak, Clerk, Cloudflare Access. In the provider, create an application with a client secret, then note three things:
  - the **issuer** (or the provider's discovery URL, which is fine to paste),
  - the **client ID**,
  - the **client secret**.

  Register this redirect URI on the application: `https://<panel address>/auth/callback`. The wizard shows it before it deploys anything. Two providers need specific settings:
  - **Clerk:** add an OAuth application (Dashboard → OAuth applications) with the scopes `openid`, `email`, `profile` and `offline_access`, and copy its client secret when it's shown, because Clerk shows it once. The issuer is your Clerk frontend URL.
  - **Cloudflare Access:** add a SaaS application of type OIDC (Zero Trust → Access controls → Applications) with the scopes `openid`, `email` and `profile`, plus `groups` if group names should decide who signs in. The issuer is `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`. Access policies decide who can sign in.
- **Decide on addresses.** Both are optional, and the defaults need nothing:
  - *The panel's address.* Its `workers.dev` address works as it is. A custom domain (like `admin.my-agency.com`) is attached for you when the domain's zone is in the same Cloudflare account.
  - *The org.* A domain you own (like `my-agency.com`) gets one DNS record and lets the panel move addresses later without touching sites. With no domain, leave the org empty and the panel's own address is the org. A site then trusts that exact address, so moving to a domain later means moving every site to the new org (see [Orgs](#orgs)).

## 1. Deploy the panel

```sh
bunx vibe-cms admin deploy
```

It runs from any directory and needs no project. It asks everything first, shows a plan, and creates nothing until you confirm. In order, it asks for:

1. The Cloudflare account, if you have several.
2. Whether to set up a new panel, reuse one saved on this machine, or search Cloudflare for one.
3. The Worker name, the D1 database name, and whether to keep daily backups in an R2 bucket (and its name). Names that already exist can be reused.
4. Your org's domain, or nothing to use the panel's own address.
5. The identity provider: its issuer (checked against its discovery document straight away), the client ID, who may sign in (email domains or group names; empty means whoever the provider lets in), and, if the provider doesn't say whether emails are verified, whether to trust them.
6. A custom domain for the panel, or nothing for its `workers.dev` address.
7. The client secret, stored as a Worker secret and never printed.

The plan lists the redirect URI to register at your provider and the `wrangler` commands that create the database and bucket. Confirm it, and the wizard creates them, deploys the panel, and prints:

- the **redirect URI** to register at the provider (if you haven't yet),
- the org's **DNS record**, added for you when the domain's zone is in the account (an existing record is never overwritten), or printed to add yourself,
- the **setup link**.

The panel's settings are saved, without secrets, in `~/.config/vibe-cms/panels/<account id>/<worker name>/`. Run the wizard again whenever you want to redeploy after upgrading `vibe-cms` (it shows the version the panel is running next to the one it will deploy), change settings, replace the signing key or the client secret, or find a panel you deployed from another machine.

### Sign in for the first time

Open the setup link in a browser and sign in with your identity provider. You become the panel's owner, and the link stops working. Until someone claims the panel nobody can sign in, so keep the link to yourself. If you lose it before using it, run the wizard again for a new one.

Then use **People** to invite others: add an email address and a role, and it becomes theirs when they sign in with that verified email. The panel sends no email, so tell them its address yourself.

## 2. Deploy a site

A site is your own Worker with the CMS in it (`vibe-cms docs getting-started`). To deploy it on Cloudflare it needs:

| Needs | Why |
|---|---|
| A D1 database, bound however you like (`DB` in the examples) | Content. The CMS creates its tables (prefixed `vibe_`) on the first request. |
| An R2 bucket (`MEDIA`) | Media files. Optional if the site has no media. |
| The cron trigger `"* * * * *"` | Scheduled publishing, and emptying the trash after 30 days. |
| The assets binding with the editor built into it | The editor is static files under `/_vibe/admin/`. |
| The `nodejs_compat` compatibility flag | Required by the CMS. |
| The `global_fetch_strictly_public` compatibility flag | Needed when the panel and the site are both on `workers.dev` in one Cloudflare account, so they can call each other. Harmless otherwise. |
| `dev` off | It is unless you set it. A site with `dev: true` lets anyone sign in with every permission. |

With a `wrangler.jsonc`:

```jsonc
{
  "main": "src/worker.ts",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": "dist/client", "binding": "ASSETS", "not_found_handling": "none" },
  "d1_databases": [{ "binding": "DB", "database_name": "my-site", "database_id": "…" }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "my-site-media" }],
  "triggers": { "crons": ["* * * * *"] }
}
```

Create the resources first: `bunx wrangler d1 create my-site` and `bunx wrangler r2 bucket create my-site-media`, then put the database ID and bucket name in the config.

With Alchemy (`examples/blog`), declare the same things in `alchemy.run.ts`; Alchemy creates the resources and writes `wrangler.jsonc`:

```ts
export const site = await Website("site", {
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  bindings: { DB: db, MEDIA: media },
  crons: ["* * * * *"]
  // …
});
```

Build and deploy:

| Setup | Build | Deploy |
|---|---|---|
| Alchemy | included | `bun run deploy` |
| Vite + `@cloudflare/vite-plugin` | `vite build` | `wrangler deploy` |
| Astro + `@astrojs/cloudflare` | `astro build` | `wrangler deploy` |
| Wrangler only | `vibe-cms build-admin --out <assets dir>/_vibe/admin` | `wrangler deploy` |

Check that the client output contains `_vibe/admin/index.html` before deploying. Note the site's address when it's done.

## 3. Connect the site to the panel

Either set the site's org when you deploy it, or deploy without and attach it afterwards. Attaching is the easiest, because you never type the org.

### Attach it with a claim link

A site deployed without `VIBE_ORG` prints a one-time **claim link** to its logs the first time it gets a request: `https://<site>/_vibe/admin/#claim=…`. Hand it to the panel in any of these ways:

- Paste it into the panel's **Add a site** box.
- Run `bunx vibe-cms admin attach "<link>" --hub <org or panel address>`.
- Skip the link and give the CLI the site's address. It asks the site for its link and reads it for you through your `wrangler` login:

  ```sh
  bunx vibe-cms admin attach https://<site> --hub <org or panel address>
  ```

  To only print the link, run `bunx vibe-cms admin claim-link https://<site>`.

The panel tells the site which org it belongs to and adds it, and you become its owner. The site first checks that the org's panel is reachable and serving keys, so with a DNS-based org the `_vibe-hub` record has to exist. A refused claim leaves the link working: fix the problem and try again.

### Or set the org when you deploy

Put the org on the site (`"vars": { "VIBE_ORG": "my-agency.com" }`, or the panel's address if that's your org), deploy it, and add it to the panel by its address (**Add a site**, then the URL). The panel checks the site names its org and makes you the owner.

### After it's added

Choose a role template when you add a site if you have one (the panel's default otherwise). Give people roles on the site under **People and roles**. The site's editor opens from the panel. Agents connect to the panel's `/mcp` address, not to each site (`vibe-cms docs agents`).

## 4. Move your content

To bring content you made locally onto the deployed site, export it and import it:

```sh
bunx vibe-cms export --site http://localhost:1337
bunx vibe-cms login <org or panel address>
bunx vibe-cms import <file>.vibe --site https://<site> --dry-run
bunx vibe-cms import <file>.vibe --site https://<site>
```

- `export` writes a `.vibe` file (content, versions and media) into the current folder. Run it with the local dev server up, using its address and port.
- `login` signs the CLI in through the panel in your browser. A login belongs to the project folder it's run in (the nearest folder with a `vibe-cms.config.*`).
- `--dry-run` lists what would change, table by table, and changes nothing.
- `import` replaces the site's content and media with the file's. It asks you to confirm, saves the site as it was to a `-before-import` file next to the file you imported, then uploads (several files at once) and verifies. Each step reports how long it took.
- The warning "The snapshot is of another site" is expected when importing a local export: the deployed site keeps its own identity, its place in the panel, and everyone's sign-in.
- You need `backups` permission on the site. The person who attached it is its owner, which has every permission.
- An import that stops part-way can be run again, and it resumes.

For copies kept outside Cloudflare on a schedule, use the panel's backups (`vibe-cms docs backups`).

## Reference

### Custom domains

A custom domain for the panel or a site is a setting, not a change to how they work. A panel's domain is attached by the wizard when its zone is in the same account; otherwise it deploys to `workers.dev`, and you attach the domain in Cloudflare (**Workers → Settings → Domains & Routes**) or add a CNAME at your DNS host, then run the wizard again. For a site, add a Workers custom domain in the same place, or a `routes` entry with `custom_domain: true` in `wrangler.jsonc`. A site on its own domain doesn't need `global_fetch_strictly_public`.

### Orgs

An org is the name a site and its panel agree on. A **domain** (like `my-agency.com`) is found through a DNS record, so the panel can move without redeploying sites:

```
_vibe-hub.my-agency.com   TXT   "https://admin.my-agency.com"
```

The wizard adds it when the domain's zone is in the account. An org can also be a **URL** (the panel's own address): sites then use that address directly, with no DNS record, and it can't change without moving sites to a new org.

To **move the panel to another address** (with a domain org): register the new redirect URI at your identity provider, deploy the panel there, and change the TXT record. Sites look the record up again within its TTL (a minute to an hour); nothing is redeployed.

To **rename the org** (say `my-agency.com` → `new-agency.com`): add `_vibe-hub.new-agency.com`, then run the wizard, choose **Change settings**, and enter the new org. The panel remembers its previous orgs and asks each site to move, signed with its key. A site waits **72 hours** (`VIBE_ORG_MOVE_DELAY`, in seconds, changes it) before it trusts the new org. Meanwhile its editor shows a banner, anyone who can change the site's settings can cancel the move, and the panel keeps signing for the old org so nobody is locked out.

Also good to know:

- A site stores its org in its database. Once it has one, removing `VIBE_ORG` keeps it (with a warning), and changing `VIBE_ORG` to a different value replaces it. `VIBE_ORG_RESET=1` makes the variable the authority again, or with no `VIBE_ORG` signs the site out of its org.
- Each site keeps a copy of its panel's public keys, so it keeps working when the DNS record or the old panel is already gone.
- A site's org history (set, claimed, move requested, cancelled, moved) is at `GET /_vibe/api/org` for users who can change the site's settings.

### Environments

`dev` must be false in production. It defaults to `import.meta.env.DEV`, which Vite sets only for `vite dev`. Without Vite, set it from a variable that you never set in production (`vibe-cms docs wrangler`).

### The site's own descriptor

`https://<site>/.well-known/vibe-cms` describes the site to panels: its id, name, accent, icon, its org and the panel's address, a pending org move, and the editor's URL. The editor only opens inside the panel; `https://<site>/_vibe/admin/` on its own links to the site's page there.

## When something goes wrong

| You see | What to do |
|---|---|
| The identity provider says the redirect URI doesn't match | Register `https://<panel address>/auth/callback` on the provider's application, exactly (scheme, host and path). |
| "This panel has no owner yet" | Open the setup link. If you've lost it, run `bunx vibe-cms admin deploy` again for a new one. |
| "Your account isn't allowed to use this panel" | The provider's account doesn't match **who may sign in**. A domain rule needs a verified email: if the provider doesn't say, trust its emails in the wizard. |
| People are asked to sign in again after about an hour | The provider isn't giving refresh tokens. Enable `offline_access` on its application (the wizard warns when a provider doesn't offer it). |
| Adding a site says Cloudflare won't let one Worker call another | Add `global_fetch_strictly_public` to both the panel and the site, and deploy both again. |
| The claim link isn't in the logs | Run `bunx vibe-cms admin claim-link https://<site>`. A site deployed before claim links existed needs redeploying first. |
| Attaching says the org's record or keys can't be found | Add the `_vibe-hub` TXT record (or use the panel's own address as the org), then try the same link again. |
| The site says it already belongs to an org, or has its own owners | It's already attached, or someone claimed it with its setup link. Add it by its address instead. |
| `import` fails the check | The file has content types the site doesn't define: deploy the site code that defines them first (`vibe-cms docs schema-changes`). |
