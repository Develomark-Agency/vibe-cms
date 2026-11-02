# Server hooks

Every hook a plugin's server entry can return: when it runs, what it receives, what it may change, and what the API answers when it refuses.

A server entry returns an object of hooks (see `vibe-cms docs plugins` for the entry itself). There are three kinds:

- **transform** hooks run in config order, one after another, and change the `output` argument in place.
- **observe** hooks run concurrently after the response, and can't change anything.
- **register** hooks are maps the CMS looks things up in.

| Hook | Kind | Runs | May |
|---|---|---|---|
| `content.beforeValidate` | transform | on create, update and publish, before validation | change the raw `doc` |
| `content.beforeWrite` | transform | on create, update and publish, after validation | change `doc`, or throw to refuse the write |
| `content.afterWrite` | observe | after every write, publish, unpublish, delete and trash restore | react: webhooks, cache purges, indexing |
| `content.beforeDelete` | transform | before a whole document is moved to the trash | set `cancel` to refuse |
| `content.read` | transform | on each document a query returns | change what's returned |
| `media.beforeUpload` | transform | before an upload is stored | rename, pick the folder, set `reject` to refuse |
| `media.analyze` | register | on upload, by MIME pattern | return metadata for the asset |
| `routes` | register | on `/_vibe/plugins/<name>/…` requests | answer HTTP (`vibe-cms docs plugin-routes`) |
| `cron` | register | on the Worker's `scheduled` event, by cron expression | run jobs |
| `queues` | register | on the Worker's `queue` event, by queue name | consume messages |

## The write pipeline

Creating or updating a document (in the editor, over the API, MCP or CLI, or restoring an old version) runs:

1. `content.beforeValidate(input, { doc })`: `doc` is a copy of the raw input. Nothing is checked yet.
2. Validation against the schema, plus reference checks. Unknown keys are dropped.
3. `content.beforeWrite({ …input, valid }, output)`: `output` is `{ type, valid, doc }`, with the validated document.
4. Validation again, plus `unique` checks. Fields a plugin set that the schema doesn't declare are dropped here.
5. The draft is saved, even if it has issues (drafts may be incomplete). The response carries the issues.
6. `content.afterWrite` (observe).

Publishing runs steps 1–4 again on the saved draft with `action: "publish"`, refuses with 422 if there are issues, and stores the result as both the draft and the published copy. Scheduled publishing runs the same steps when the schedule fires. Unpublishing runs no transform hooks.

`input` is `{ type, id, locale, action, session }`. `action` is `"create"`, `"update"` or `"publish"`. `session` is the editor or agent making the change (`{ sub, email, name, roles }`), and is `undefined` for writes from trusted code such as cron.

### Fill fields before validation

Use `content.beforeValidate` to fill a required field the input left empty, so the document validates:

```ts
// examples/plugins/src/slugs/plugin.server.ts
  "content.beforeValidate": (input, output) => {
    const { doc } = output;
    if(input.type === "post" && !doc.slug && typeof doc.title === "string") doc.slug = slugify(doc.title);
  },
```

### Derive fields after validation

In `content.beforeWrite`, check `output.type` and `output.valid` together: with `defineServer<typeof Plugin, typeof config>`, that narrows `output.doc` to the content type's stored shape. Drafts that failed validation stay plain JSON.

```ts
// examples/plugins/src/slugs/plugin.server.ts
  "content.beforeWrite": (_input, output) => {
    if(output.type !== "post" || !output.valid) return;
    output.doc.wordCount = output.doc.body.split(/\s+/).filter(Boolean).length;
  }
```

A derived field must be declared in the schema, or step 4 drops it. Mark it `readOnly` so the editor shows it without letting anyone edit it (or `hidden` to not show it at all):

```ts
// examples/plugins/vibe-cms.config.ts
      // Derived by the slugs plugin on every write: declared so it's kept, read-only so editors can't change it.
      wordCount: v.optional(v.number({ integer: true, readOnly: true })),
```

### Refuse a write

Throw from `content.beforeWrite`. The API answers 422 with your message (action error tag `Rejected`), and the editor shows it.

```ts
// examples/plugins/src/rules/plugin.server.ts
  // Throwing rejects the write: the API answers 422 with the message.
  "content.beforeWrite": (input, output) => {
    if(input.action !== "publish" || output.type !== "post" || !output.valid) return;
    const word = options.blockedWords.find(w => output.doc.title.includes(w));
    if(word) throw new Error(`Remove "${word}" from the title before publishing`);
  },
```

Refusing a publish leaves the saved draft as it is. That includes `documents.create` with `publish: true`: the draft is created, then the publish is refused.

## `content.afterWrite`

Runs after the change is stored, inside `ctx.waitUntil`, so the response doesn't wait for it. Errors are logged and never reach the caller. Its input is `{ type, id, locale, action, valid, doc }`:

| `action` | `doc` | `valid` |
|---|---|---|
| `create`, `update` | the saved draft | whether it has no issues |
| `publish` | the published document | `true` |
| `unpublish`, `delete`, `restore` | `null` | `false` |

Deleting a whole document reports `locale: "*"`; deleting one translation reports its locale. `restore` means restored from the trash.

```ts
// examples/plugins/src/webhook/plugin.server.ts
export default defineServer<typeof WebhookPlugin>(({ bindings, options, log }) => ({
  // Observes: runs after the response is sent (through `waitUntil`); errors are logged, never returned.
  "content.afterWrite": async ({ type, id, locale, action }) => {
    if(action !== "publish" && action !== "unpublish") return;
    if(options.types && !options.types.includes(type)) return;
    const response = await fetch(bindings.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, id, locale, action })
    });
    if(!response.ok) log.warn(`webhook: ${bindings.url} answered ${response.status}`);
  }
}));
```

## `content.beforeDelete`

Runs when a whole document is deleted, after the reference check (deleting a document others reference is already refused with 409 unless forced). Set `output.cancel` to a message to refuse: the API answers 409 (tag `Conflict`). Deleting a single translation doesn't run this hook.

```ts
// examples/plugins/src/rules/plugin.server.ts
  // Setting `cancel` blocks the delete: the API answers 409 with the message.
  "content.beforeDelete": async (input, output) => {
    if(input.type !== "post") return;
    // Server plugins may read drafts: the in-process client is trusted.
    const doc = await cms.query(post, { drafts: true }).findById(input.id);
    if(doc?.pinned) output.cancel = "Unpin this post before deleting it";
  }
```

## `content.read`

Runs on each document a query returns (`findMany`, `findFirst`, `findById`), after assets are resolved and `with:` expansions are added: through `vibe.client(env)`, `createClient`, `POST /_vibe/api/query` and a plugin's `cms`. The editor's document form and lists, and the `documents.get` and `documents.list` actions, return stored drafts without it. `input` is `{ type, drafts }`; change `output.doc` in place.

```ts
"content.read": (input, output) => {
  if(output.type === "post" && !output.drafts) output.doc.title = output.doc.title.trim();
}
```

Published reads (`drafts: false`) are valid documents in their output shape; drafts may not be.

## Media hooks

`media.beforeUpload` gets `{ mime, size, session }` and an `output` of `{ filename, folder, reject? }`. `folder` starts as the upload's folder (or the asset field's `folder` option), possibly `null`. Setting `reject` refuses the upload with 422.

`media.analyze` maps MIME patterns (`"text/*"`, `"application/pdf"`) to extractors. Each matching extractor gets the first 256 KB of the file and its MIME type; what it returns is merged into the asset's `meta`, which asset field `validate` functions and queries see. Image width and height are built in.

```ts
// examples/plugins/src/media/plugin.server.ts
export default defineServer<typeof MediaPlugin>(({ options }) => ({
  // Before anything is stored: rename, choose the folder, or refuse with `reject` (the API answers 422).
  "media.beforeUpload": (input, output) => {
    if(!input.mime.startsWith("image/") && input.size > options.maxSize) {
      output.reject = `Files other than images can be at most ${options.maxSize / 1_000_000} MB`;
      return;
    }
    output.filename = output.filename.toLowerCase().replace(/\s+/g, "-");
    output.folder ??= input.mime.startsWith("image/") ? "images" : "files";
  },
  // Metadata extractors by MIME pattern. They get the file's first 256 KB; what they return is merged into the asset's `meta`.
  "media.analyze": {
    "text/*": bytes => ({ lines: new TextDecoder().decode(bytes).split("\n").length })
  }
}));
```

## `cron` and `queues`

Both are keyed by what Cloudflare sends: `cron` by the cron expression, which must exactly match a trigger on the Worker (wrangler `triggers.crons`), and `queues` by queue name, which the Worker must consume (`queues.consumers`). The handler from `createHandler`, wrapped around your Worker with `vibe({ … })`, routes the events. A cron trigger runs the CMS's own jobs (scheduled publishing, trash purging) and every plugin job for that expression; a queue batch goes to the first plugin that claims the queue, else to your Worker's `queue` handler.

```ts
// examples/plugins/src/scheduled/plugin.server.ts
  cron: {
    "0 * * * *": async () => {
      const [all, live] = await cms.batch([cms.query(post, { drafts: true }).count(), cms.query(post).count()]);
      log.info(`scheduled: ${all - live} posts never published`);
    }
  },
  // Keyed by queue name. A batch for a queue no plugin claims goes to your Worker's own `queue` handler.
  queues: {
    "post-events": async batch => {
      for(const message of batch.messages) log.info("scheduled: event", message.body);
    }
  }
```

A failing cron job is logged and doesn't stop the others.
