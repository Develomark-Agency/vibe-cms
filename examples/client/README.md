# Client example

Reading a vibe-cms site's content from outside its Worker: scripts, other apps and browsers. It reads the [worker example](../worker), so start that first (`bun run dev` there).

| File | What |
|---|---|
| `src/read.ts` | `createClient<typeof config>({ url })`: typed published reads, `batch` |
| `src/drafts.ts` | Draft reads with a site session token |
| `src/raw.ts` | `POST /_vibe/api/query` with plain JSON, no client |
| `src/Posts.tsx` | `useContent` in a React component |

```sh
bun run read
bun run drafts
bun run raw
SITE_URL=https://my-site.example bun run read
```

See `vibe-cms docs http-client`.
