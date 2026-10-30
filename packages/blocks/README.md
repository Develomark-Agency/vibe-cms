# @vibe-cms/blocks

Pages built from blocks. Editors add a page, pick blocks from a menu, drag them into order and fill in their fields. Your site looks the page up by its path and renders the blocks with its own components.

## Define

A block's definition says what it is (its type, label, icon and inputs). It lives in your CMS config, so it contains no rendering code.

```ts
// src/blocks/definitions.ts
import { defineBlock } from "@vibe-cms/blocks";
import v from "vibe-cms/schema";

export const Testimonial = defineBlock({
  type: "testimonial",
  label: "Testimonial",
  icon: "message-square",
  description: "A customer quote with their name",
  fields: { quote: v.text({ multiline: true }), name: v.text() }
});
```

```ts
// vibe-cms.config.ts
import { pageSchema } from "@vibe-cms/blocks";

collections: { page: { icon: "layout", title: "title", preview: "{path}" } },
schemas: { page: pageSchema({ blocks: [Testimonial, Pricing] }) }
```

`pageSchema` gives a page a title, a `path` (validated, unique per locale), a search description and its blocks: the built-ins plus yours. Pages are ordinary documents, so drafts, publishing, versions, translations and preview all apply. For a block list of your own, use `blocks([...])` as a field.

**Built-in blocks:** Hero, Text (rich text), Image, Gallery, Call to action, Quote, Video (YouTube, Vimeo or a file), FAQ and Divider. They render as plain, JavaScript-free HTML in every adapter unless you pass your own component for the type. `@vibe-cms/blocks/styles.css` gives them a neutral look you can tune with `--vb-*` custom properties.

## Render

Look the page up by path, then render its blocks with a map of block type → component. The map must cover every custom block type; leaving one out is a type error. Built-ins are optional overrides.

### Astro

```astro
---
import { findPage } from "@vibe-cms/blocks";
import { Blocks } from "@vibe-cms/blocks/astro";
import "@vibe-cms/blocks/styles.css";
import Testimonial from "../blocks/Testimonial.astro";  // Astro component
import { FeatureGrid } from "../components/FeatureGrid";  // React, rendered on the server
import Pricing from "../blocks/Pricing.astro";            // wrapper around an interactive React island

const entry = await findPage(cms, page, Astro.url.pathname);
if(!entry) return new Response(null, { status: 404 });
---
<Blocks blocks={entry.blocks} components={{ testimonial: Testimonial, features: FeatureGrid, pricing: Pricing }} />
```

Astro, React, Vue and Svelte components mix freely in one map. For a block with state and handlers, map its type to a one-line Astro wrapper, because Astro only hydrates components written with a `client:` directive in a file:

```astro
---
import { PricingToggle } from "../components/PricingToggle";
---
<PricingToggle client:visible {...Astro.props} />
```

Each component types its props with `BlockProps<typeof Testimonial>`. Astro's component types are loose, so `<Blocks>` checks which types the map covers but not each component's props.

### React (Next.js, Remix, …)

```tsx
import { Blocks } from "@vibe-cms/blocks/react";

<Blocks blocks={entry.blocks} components={{ testimonial: Testimonial, pricing: PricingToggle }} />
```

`<Blocks>` uses no hooks, so it works as a Server Component: static blocks ship no JavaScript, and components marked `"use client"` hydrate with full state and handlers. Built-ins render inside a `display: contents` wrapper.

### Plain HTML

```ts
import { html, renderBlocks } from "@vibe-cms/blocks/html";

renderBlocks(entry.blocks, {
  components: { testimonial: b => html`<blockquote>${b.quote}</blockquote><p>${b.name}</p>` }
});
```

`html` escapes everything you interpolate (`raw()` opts out, `url()` keeps links to safe schemes), so block content can't inject markup. Use this adapter for Workers, Vue or anything else.

## Paths

`findPage` normalises the URL path the way paths are stored (`/About/Team/` → `/about/team`) and returns the published page or `null`. Pass `{ locale }` for translations, or `{ drafts: true }` from a trusted preview route.
