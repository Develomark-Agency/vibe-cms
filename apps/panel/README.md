# vibe-cms panel

The agency's front door: sign in once, pick a site, edit it. Sites are added by URL; each site decides what you may do there.

## Deploy

1. Register an OIDC client with your identity provider. Redirect URI: `https://<panel host>/auth/callback`.
2. Create the database: `bunx wrangler d1 create vibe-panel`, and put its ID in `wrangler.jsonc`.
3. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `PANEL_ALLOW` in `wrangler.jsonc`, and the secret with `bunx wrangler secret put OIDC_CLIENT_SECRET`.
4. Optionally white-label it with `PANEL_NAME`, `PANEL_ACCENT` (`#rrggbb`) and `PANEL_ICON` (an image URL).
5. `bun run deploy`.

Sites that should appear in this panel use the same issuer and client ID in their config:

```ts
auth: oidc({ issuer: "https://accounts.google.com", clientId: "<this panel's client ID>" })
```

## Develop

```sh
echo 'OIDC_CLIENT_SECRET=…' > .dev.vars
bun run dev
bun test          # sign-in and handoff against a mock identity provider and a real site handler
```

For working on sites without an identity provider, use the local panel instead: `bunx vibe-cms admin`.
