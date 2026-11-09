# Plugin actions

How a plugin adds actions: callable by name from REST and the CLI, and, when the plugin says so, as tools for AI agents.

An action is a named operation with a typed input. The CMS's own operations (`documents.create`, `assets.upload`, …) are actions, and a plugin's go in the same place under its name. They show up everywhere the built-in ones do:

| Surface | A plugin `stats` with action `longest` is |
|---|---|
| REST | `POST /_vibe/api/actions/stats.longest`, with the input as JSON |
| CLI | `vibe-cms action stats.longest --input '{"limit":3}' --site <url>` |
| Listing | `GET /_vibe/api/actions` and `vibe-cms actions` (signed-in users also see the plugin's) |
| MCP | the tool `stats_longest`, only if the action declares `mcp: true` |

The `stats` plugin in `examples/plugins` has two. Each is made with `defineAction`, and `actions` is a plain object keyed by the action's name:

```ts
// examples/plugins/src/stats/plugin.server.ts
  actions: {
    longest: defineAction({
      summary: "Longest posts",
      description: "The published posts with the most words, longest first.",
      readOnly: true,
      mcp: true,
      input: z.object({ limit: z.number().int().min(1).max(20).default(5).describe("How many posts") }),
      handler: async ({ input }) => {
        const posts = await cms.query(post).findMany({ orderBy: [desc(post.wordCount)], limit: input.limit });
        return posts.map(p => ({ title: p.title, slug: p.slug, words: p.wordCount ?? 0 }));
      }
    }),
```

`defineAction` comes from `vibe-cms/server`, next to `defineServer`. `summary` and `description` are required: agents and `vibe-cms actions` show them, and the site refuses to start without them. The handler gets the parsed `input` and the `engine`, the signed-in user's view of the site. An action with no `input` takes none.

## Input schemas

`input` can be a schema from any library that implements both [Standard Schema](https://standardschema.dev) (to validate) and Standard JSON Schema (to describe the input to agents). Zod 4 and ArkType do. Valibot's schemas only validate: wrap one with `toStandardJsonSchema` from `@valibot/to-json-schema`. Effect keeps the two in separate objects (`Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1`), which the CMS doesn't join for you. The site describes every action's input when it starts, and refuses to start if one can't be described, naming the action.

Plugin actions take JSON, which is what `vibe-cms action`, `POST /_vibe/api/actions/<name>` and agents send. The text formats (a form's fields, query strings, per-field CLI flags) are only for the built-in actions.

## Files

Actions don't take files as input. A file goes into the media library first, and the action takes the asset's ID, as the CMS's own media fields do (`{ asset: "<id>" }`, `vibe-cms docs media`):

1. The caller uploads it with `assets_upload` (MCP), `assets.upload` (REST, the CLI) or the editor, and gets an ID back.
2. The action takes that ID as a string, and the handler reads the file with `engine`, which applies the signed-in user's media permissions:

```ts
// examples/plugins/src/stats/plugin.server.ts
    countWords: defineAction({
      summary: "Count words in a text file",
      description: "The number of words in an uploaded text file.",
      readOnly: true,
      mcp: true,
      input: z.object({ asset: z.string().describe("An asset's ID, from assets_upload or assets_list") }),
      handler: async ({ input, engine }) => {
        const file = await engine.readAsset(input.asset);
        return { name: file.name, words: (await file.text()).split(/\s+/).filter(Boolean).length };
      }
    })
```

A file never travels inside the action's JSON: nothing in the input schema is special, any schema library works, and a call stays small.

Read a large file in chunks, or pipe it on, rather than loading it:

```ts
const { stream } = await engine.streamAsset(input.asset);
const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
for(let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
  // chunk.value is the next piece of text; handle it, then let it go
}
```

What `engine` offers for assets (all need the user's media permissions):

| Method | Does |
|---|---|
| `readAsset(id, { maxBytes? })` | The content as a `File` (`text()`, `arrayBuffer()`, `stream()`), named and typed like the asset. It reads the whole file into memory, so files over 10 MB are refused with `413` unless you raise `maxBytes`. |
| `streamAsset(id)` | `{ stream, name, type, size }`: the content as a `ReadableStream`, for files too large to hold in memory (a Worker has little). No size limit. |
| `getAsset(id)` | Its details: filename, type, size, URL, metadata, and the documents using it. |
| `updateAsset(id, { filename?, folder? })` | Renames or moves it (needs write access). |

## Names

Actions are namespaced by the plugin's `name`: the key in `actions` becomes `stats.longest`. A plugin can't use the name of a built-in group (`documents`, `assets`, `schema`, `folders`, `trash`, `site`, `backups`); the site fails to start if it does. Actions are flat: there are no groups inside a plugin.

## Who may run them

Plugin actions don't go through the engine's checks the way built-in ones do, so the CMS checks before the handler runs:

- A signed-in user is required. Nothing is public.
- Read-only connections (agents the user approved read only) can only run actions marked `readOnly: true`.
- `permit` names a permission the user must have, using the same rules as everything else (`vibe-cms docs permissions`): `permit: { action: "write", scope: "site" }`.

```ts
defineAction({ summary: "Rebuild search", description: "Rebuilds the search index.", permit: { action: "write", scope: "site" }, handler: … })
```

A failed check is a `401` or `403` (`UNAUTHORIZED`, `FORBIDDEN`). Anything finer is for the handler, which can use `engine` and the `cms` client the plugin was given (trusted, reads drafts).

Annotations (`readOnly`, `destructive`, `idempotent`) are hints that agents show their users before running a tool. Set them truthfully.

## Offering actions to agents

`mcp` decides whether agents see an action as a tool. Plugin actions default to `false`: an action stays available to REST and the CLI, and an agent only gets it when the author opts it in. Built-in actions are tools unless they say otherwise.

`instructions` in the server entry is text for agents on using the plugin's tools. It is added to the site's MCP instructions, and shown by `site_actions_list` on the panel, only when the plugin offers at least one tool.

How agents get them depends on how they connect (`vibe-cms docs agents`):

- Connected to the site (development, or a site without an org): each action is its own tool, `stats_longest`.
- Connected to the agency panel: not as tools of their own, since the panel serves many sites with different plugins. The agent calls `site_actions_list` with a site to see its extras with their inputs, then `site_action_call` with the action's name and input.
