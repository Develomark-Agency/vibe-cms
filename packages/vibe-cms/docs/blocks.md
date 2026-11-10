# Blocks

Pages built from blocks with `vibe-cms/blocks`: defining blocks, the page schema, block lists as fields, and rendering them with your own components.

Blocks are how editors build pages. A site usually has one `page` content type from `pageSchema()`, and every page editors manage is a document of it, each at its own `path`: `/` for the home page, `/about`, `/services/design`. Editors compose each page from blocks; the site renders them with its own components. A catch-all route renders them all (`vibe-cms docs astro` shows the routing).

A block is a named object schema: `defineBlock` gives it a type, a label and icon for the editor's "Add block" menu, and its fields. It contains no rendering code, so it's safe in the config. Each block also gets a hidden `_key` from the CMS, which tells it apart from its neighbours across saves, so moving one shows as a move when publishing (`vibe-cms docs publishing`). A block can't have its own `type` or `_key` field.

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
- `pageSchema({ blocks })` is a whole content type: `title`, `path` (`format: "path"`, indexed, unique per locale), an optional search `description`, and `blocks` with the built-in blocks plus yours. Give its collection `preview: "{path}"`, so the editor's draft preview opens the page (`vibe-cms docs preview`).

Built-in blocks: Hero, Text (rich text), Image, Gallery, Call to action, Quote, Video, FAQ and Divider. They render as plain HTML in every adapter unless you pass your own component for their type; `vibe-cms/blocks/styles.css` styles them neutrally.

## Rendering

Look the page up by its URL path, then render its blocks with a map of block type → component. The map must cover every custom block type (a type error otherwise); built-ins are optional overrides.

```astro
---
import { findPage } from "vibe-cms/blocks";
import { Blocks } from "vibe-cms/blocks/astro";
import Callout from "../blocks/Callout.astro";
import { cms, page } from "../content.ts";

const entry = await findPage(cms, page, Astro.url.pathname);
if(!entry) return new Response(null, { status: 404 });
---
<Blocks blocks={entry.blocks} components={{ callout: Callout }} />
```

| Adapter | Import | Components |
|---|---|---|
| Astro | `vibe-cms/blocks/astro` | Any Astro-renderable component; interactive ones through a one-line wrapper with a `client:` directive |
| React | `vibe-cms/blocks/react` | React components; works as a Server Component |
| HTML | `vibe-cms/blocks/html` | `renderBlocks(blocks, { components: { callout: b => html\`…\` } })`, with an escaping `html` template |

Each component's props are the block's resolved fields: type them with `BlockProps<typeof Callout>`. `findPage(cms, page, pathname, { locale, drafts })` normalises the path (`/About/` → `/about`) and returns the published page or `null`.

### Astro

Astro, React, Vue and Svelte components mix freely in one map. For a block with state and handlers, map its type to a one-line Astro wrapper, because Astro only hydrates components written with a `client:` directive in a file:

```astro
---
import { PricingToggle } from "../components/PricingToggle";
---
<PricingToggle client:visible {...Astro.props} />
```

Astro's component types are loose, so `<Blocks>` checks which types the map covers but not each component's props.

### React

`<Blocks>` from `vibe-cms/blocks/react` uses no hooks, so it works as a Server Component: static blocks ship no JavaScript, and components marked `"use client"` hydrate with full state and handlers. Built-ins render inside a `display: contents` wrapper.

### Plain HTML

```ts
import { html, renderBlocks } from "vibe-cms/blocks/html";

renderBlocks(entry.blocks, {
  components: { testimonial: b => html`<blockquote>${b.quote}</blockquote><p>${b.name}</p>` }
});
```

`html` escapes everything you interpolate (`raw()` opts out, `url()` keeps links to safe schemes), so block content can't inject markup. Use this adapter for Workers, Vue or anything else. Pass `{ locale }` to `findPage` for translations, or `{ drafts: true }` from a trusted preview route.

## Custom blocks

Custom blocks are where a site's design meets its content. The built-ins cover generic sections; a custom block is a section of *this* site, with exactly the inputs its design needs and a component that renders it however the site likes. Anything a designer would draw as a reusable section is a good block: a pricing table, a feature grid, a team section, a logo strip, a booking widget, an event listing.

What a block can hold:

- **Any field type**: text, enums for variants (`layout: v.enum(["grid", "carousel"])`, `background: v.enum(["light", "dark"])`), numbers, booleans, nested objects and arrays of items (`v.array(v.object({ title, text, icon }))` for a feature grid), rich text (`richText()`).
- **Media**: `image()`, `video()` and `file()` fields, so every picture in the section comes from the media library and stays editable.
- **References to records**: `v.array(v.ref("testimonial"), { max: 6 })` lets an editor pick which testimonials a section shows, while the testimonials themselves live in their own collection and can appear on many pages. Expand them in the query with `with` (`vibe-cms docs references`).
- **Settings for a query**: a block can hold no records at all, just how to choose them (`count: v.number({ integer: true, min: 1, max: 12 })`, `category: v.optional(v.ref("category"))`), and its component queries the collection when it renders. "Latest posts" and "upcoming events" sections work this way and stay current without editing the page. Mark what the component renders from those records with `data-vibe-field={field(record, "title")}`, so clicking it in the editor's draft preview opens that record (`vibe-cms docs preview`); the block itself is picked without marks.
- **Interactivity**: the component is yours, so it can be a hydrated island (Astro `client:` directives through a wrapper), a React component with state, or a form posting to a plugin route.

```ts
// A section that shows upcoming events, chosen by settings rather than stored copies.
export const UpcomingEvents = defineBlock({
  type: "upcoming-events",
  label: "Upcoming events",
  icon: "calendar",
  description: "The next events from the Events collection",
  fields: {
    heading: v.text({ max: 80 }),
    count: v.number({ integer: true, min: 1, max: 12 }),
    background: v.enum(["light", "dark"])
  }
});
```

```astro
---
// src/blocks/UpcomingEvents.astro
import type { BlockProps } from "vibe-cms/blocks";
import { field } from "vibe-cms/preview";
import { asc, gte } from "vibe-cms/query";
import { cms, event } from "../content.ts";
import type { UpcomingEvents } from "../../vibe-cms.config.ts";

const { heading, count, background } = Astro.props as BlockProps<typeof UpcomingEvents>;
const events = await cms.query(event).findMany({
  where: gte(event.startsAt, new Date()),
  orderBy: [asc(event.startsAt)],
  limit: count
});
---
<section class={background}>
  <h2>{heading}</h2>
  {/* Each event is its own document: clicking its title in the draft preview opens that event. */}
  <ul>{events.map(e => <li data-vibe-field={field(e, "title")}><a href={`/events/${e.slug}`}>{e.title}</a></li>)}</ul>
</section>
```

Good blocks give editors choices that matter and leave the rest to the design: an enum of three approved backgrounds rather than a colour picker, a `max` on items where the layout stops working, a `description` on the block and its fields so editors know what each does. Blocks can also be used outside pages, as a `blocks([...])` field on any content type (a post body, a product's detail sections, a footer).
