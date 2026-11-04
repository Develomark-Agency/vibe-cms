import { createActionClient, httpCaller, type CoreActions } from "vibe-cms/actions";

// A one-off script for a schema change: copy every post's old `summary` into a new `excerpt`
// field, keeping published posts published. Run it after deploying the schema with both fields.
//   VIBE_SITE=http://localhost:1337 bun src/backfill.ts
export async function backfill(actions: ReturnType<typeof createActionClient<CoreActions>>) {
  const limit = 50;
  // Oldest first: the default order (recently updated first) would shift as the script updates.
  for(let offset = 0; ; offset += limit) {
    const { docs, total } = await actions.documents.list({ type: "post", limit, offset, sort: "$createdAt" });
    for(const { id, $meta, ...data } of docs) {
      if(data.excerpt !== undefined || data.summary === undefined) continue;
      const { summary, ...rest } = data;
      await actions.documents.update({
        type: "post",
        id,
        data: { ...rest, excerpt: summary },
        // Fails with CONFLICT instead of overwriting an edit made since the list was read.
        baseUpdatedAt: Date.parse($meta.updatedAt),
        // Only republish what was live and unchanged, so unpublished draft edits stay unpublished.
        publish: $meta.status === "published"
      });
    }
    if(offset + limit >= total) break;
  }
}

if(import.meta.main) {
  const site = process.env.VIBE_SITE ?? "http://localhost:1337";
  // Development sites hand out a session; deployed sites need VIBE_TOKEN (a site session token).
  const token = process.env.VIBE_TOKEN ?? (await (await fetch(`${site}/_vibe/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dev: true })
  })).json() as { token: string }).token;
  await backfill(createActionClient<CoreActions>(httpCaller({ url: site, token })));
}
