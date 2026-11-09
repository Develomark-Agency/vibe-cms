# Staging

Run a second copy of a site for trying out changes before production: deploy it with Alchemy stages, set `VIBE_ENV` so search engines skip it, and copy production's content into it whenever you like.

A staging site is an ordinary site: its own Worker, D1 database and R2 bucket, running the code you're about to ship. Vibe CMS doesn't create it or link it to production. You deploy it like any other site, and tell it which environment it is with one variable.

## The environment: `VIBE_ENV`

`VIBE_ENV` names the deployment. It's a deploy setting, like `VIBE_ORG`, not part of `vibe-cms.config.ts`, because the same code runs as production, as staging and on your laptop.

| `VIBE_ENV` | What the site does |
|---|---|
| unset, or `production` | Nothing different. |
| unset, under a development server (`dev`) | It's `development`, so it's treated like staging. |
| `staging`, or any other name (`preview`, `qa`, …) | Every response gets `X-Robots-Tag: noindex, nofollow`, and `/robots.txt` disallows everything, whatever your own says. |

Names are letters, digits and dashes, and are compared in lowercase. A value like `my staging!` stops the site with an error, rather than quietly being treated as production.

`noindex` asks search engines not to list the site. It doesn't stop anyone from opening it: share staging links as freely as you would production's.

### Static files

Cloudflare serves files from the assets directory before your Worker runs (unless `run_worker_first` says otherwise), so the CMS never sees those requests. Two things follow:

- **A `robots.txt` in your assets wins** over the CMS's. Either serve `robots.txt` from your own `fetch` handler, or have the Worker answer it first:

  ```jsonc
  "assets": { "directory": "dist/client", "binding": "ASSETS", "run_worker_first": ["/robots.txt"] }
  ```

- **Static files don't get `X-Robots-Tag`.** Pages your Worker renders do, which covers server-rendered sites. If your pages are prerendered into the assets directory, the `robots.txt` above still keeps crawlers out. To also add the header, use `"run_worker_first": true`, or add `<meta name="robots" content="noindex">` to your layout outside production (next section).

### In your own code

`vibe.environment(env)` returns the environment's name, for anything else that should differ outside production: analytics, a "Staging" ribbon, a `noindex` meta tag.

```ts
const robots = vibe.environment(env) === "production" ? null : "noindex";
```

Plugins get the Worker's `env`, so a plugin that calls out (a webhook, an email) can read `env.VIBE_ENV` and skip it outside production.

If you route requests yourself with `vibe.match` and `vibe.handle` rather than `vibe({ fetch })`, the CMS doesn't see your pages, so add the header and `robots.txt` yourself.

## Set up staging with Alchemy

Alchemy deploys the same `alchemy.run.ts` once per **stage**, and gives each stage its own resources: `alchemy deploy --stage staging` creates a staging Worker, D1 database and R2 bucket next to production's, without touching them. So staging is a few lines, not a second project.

1. Set `VIBE_ENV` (and each stage's domain, if it has one) from the stage:

   ```ts
   const app = await alchemy("my-site");
   const production = app.stage === "production";

   export const site = await Website("site", {
     // …as before
     domains: [production ? "my-site.com" : "staging.my-site.com"],
     bindings: {
       DB: db,
       MEDIA: media,
       VIBE_ENV: production ? "production" : "staging"
     }
   });
   ```

   A plain string in `bindings` becomes a variable on the Worker. Leave out `domains` to use each stage's `workers.dev` address. A custom domain needs its zone in the same Cloudflare account.

2. Deploy each stage:

   ```sh
   bunx alchemy deploy --stage production
   bunx alchemy deploy --stage staging
   ```

   Without `--stage`, Alchemy uses your username as the stage. The example above makes every stage except `production` a staging site, so a deploy that forgets `--stage` can't be mistaken for production by search engines.

3. Connect staging to your panel like any site (`vibe-cms docs deploy`): attach it with its claim link, or set `VIBE_ORG` in its bindings too. It shows in the panel as a separate site.

With wrangler instead, put staging in an `env` block (`"env": { "staging": { "vars": { "VIBE_ENV": "staging" }, … } }`) with its own `d1_databases` and `r2_buckets`, and deploy with `wrangler deploy --env staging`.

Deploy code to staging first and production after, however you like: by hand, or from CI on different branches.

## Copy production's content into staging

Staging has its own database, so its content starts empty and drifts from production as editors work. Copy production's content into it whenever you want it current. Do this before trying a schema change, so you test it against real content:

```sh
bunx vibe-cms export --site https://my-site.com
bunx vibe-cms import <file>.vibe --site https://staging.my-site.com --dry-run
bunx vibe-cms import <file>.vibe --site https://staging.my-site.com
```

- `export` reads production and changes nothing there.
- `import` replaces all of staging's content and media with production's, after saving staging as it was to a `-before-import` file. Edits made on staging are lost, so content only ever goes from production to staging, never back.
- Staging keeps its own ID, its place in the panel, and everyone's sign-in. The "snapshot is of another site" warning is expected.
- If staging's code no longer defines a content type that production has documents of, the import refuses: deploy the code first. Changed schemas are a warning, and documents that no longer fit show their issues in the editor. That's the check you want before shipping a schema change to production.
- Data kept by plugins outside the CMS's tables, such as Durable Objects, isn't copied.

You need `backups` permission on both sites (`vibe-cms login` first). `vibe-cms docs backups` covers the format, resuming an interrupted import, and restoring from the panel instead.
