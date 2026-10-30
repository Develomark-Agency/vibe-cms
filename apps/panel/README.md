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

## AI agents

The panel is also an MCP server for every site in it: `https://<panel host>/mcp`. Anyone who can sign in to the panel can add that address to Claude, ChatGPT, Cursor or another agent as a custom connector; the account menu's **AI agents** shows it with a copy button.

1. The agent registers itself with the panel's OAuth server and opens the panel in a browser.
2. The user approves it (optionally read only) and signs in with the identity provider once more, so the agent gets a provider session of its own: signing out of the panel doesn't disconnect it, and disconnecting it doesn't sign anyone out.
3. The agent calls `sites_list`, then any action with a `site` argument. The panel gets a site session for the user through the same one-time-code handoff the editor uses, so each site still decides what that user may do.

Connected agents are listed under **AI agents**, where users can disconnect them. Nothing to configure: the OAuth endpoints are discovered from `/.well-known/oauth-protected-resource`.

## Develop

```sh
echo 'OIDC_CLIENT_SECRET=…' > .dev.vars
bun run dev
bun test          # sign-in and handoff against a mock identity provider and a real site handler
```

For working on sites without an identity provider, use the local panel instead: `bunx vibe-cms admin`.
