# Blocks

Pages built from blocks with `@vibe-cms/blocks`: defining blocks, the page schema, block lists as fields, and rendering them with your own components.

```bash
bun add @vibe-cms/blocks
```

A block is a named object schema: `defineBlock` gives it a type, a label and icon for the editor's "Add block" menu, and its fields. It contains no rendering code, so it's safe in the config.

```ts
// examples/schemas/src/presets.ts
// A block is a named object schema; the site renders it with its own component.
export const Callout = defineBlock({
  type: "callout",
  label: "Callout",
  icon: "megaphone",
  fields: {
    text: v.text({ multiline: true }),
    tone: v.enum(["info", "warning"])
  }
});
```

Use blocks in two ways:

```ts
// examples/schemas/src/presets.ts
      // A block list as a field of your own.
      sidebar: blocks([Callout], { max: 3 })
    }),
    // A page with a title, a unique `path`, a search description and blocks (built-ins plus yours).
    page: pageSchema({ blocks: [Callout] }),
```

- `blocks([...], { label, description, min, max })` is a field: an array of a union told apart by each block's `type`. The editor gives it drag-to-reorder, insertion points and a searchable add menu.
- `pageSchema({ blocks })` is a whole content type: `title`, `path` (`format: "path"`, indexed, unique per locale), an optional search `description`, and `blocks` with the built-in blocks plus yours. Give its collection `preview: "{path}"`.

Built-in blocks: Hero, Text (rich text), Image, Gallery, Call to action, Quote, Video, FAQ and Divider. They render as plain HTML in every adapter unless you pass your own component for their type; `@vibe-cms/blocks/styles.css` styles them neutrally.

## Rendering

Look the page up by its URL path, then render its blocks with a map of block type → component. The map must cover every custom block type (a type error otherwise); built-ins are optional overrides.

```astro
---
import { findPage } from "@vibe-cms/blocks";
import { Blocks } from "@vibe-cms/blocks/astro";
import Callout from "../blocks/Callout.astro";
import { cms, page } from "../content.ts";

const entry = await findPage(cms, page, Astro.url.pathname);
if(!entry) return new Response(null, { status: 404 });
---
<Blocks blocks={entry.blocks} components={{ callout: Callout }} />
```

| Adapter | Import | Components |
|---|---|---|
| Astro | `@vibe-cms/blocks/astro` | Any Astro-renderable component; interactive ones through a one-line wrapper with a `client:` directive |
| React | `@vibe-cms/blocks/react` | React components; works as a Server Component |
| HTML | `@vibe-cms/blocks/html` | `renderBlocks(blocks, { components: { callout: b => html\`…\` } })`, with an escaping `html` template |

Each component's props are the block's resolved fields: type them with `BlockProps<typeof Callout>`. `findPage(cms, page, pathname, { locale, drafts })` normalises the path (`/About/` → `/about`) and returns the published page or `null`.

The `@vibe-cms/blocks` package README has more on each adapter.
