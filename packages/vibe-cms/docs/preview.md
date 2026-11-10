# Draft preview

Editors see the site with their saved drafts in a floating window over the editor, or in a window of its own. The preview reloads whenever anything is saved, not only published.

## How it works

1. The editor's **Preview** (in the sidebar, the command palette, or the eye button on a document with a `preview` URL) asks the site for a one-time code and opens `{prefix}/preview?code=…&path=/…`.
2. The site trades the code for a `vibe_preview` cookie (the editor's session, `HttpOnly`) and redirects to the page. The cookie lasts an hour, renewed by each preview page, and closing the preview clears it.
3. `vibe({ fetch })` sees the cookie on a page loaded **in a frame** and runs your `fetch` inside a preview scope. There, `vibe.client(env)` reads drafts of every type the editor can read. Pages, FAQs, settings and references all show the editor's own saved changes (and the live copy where they have none), including documents never published, with no changes to your site's code. Other people's unpublished changes aren't shown until they're published.
4. Preview responses are `Cache-Control: no-store` and `X-Robots-Tag: noindex`. HTML pages get `<script src="{prefix}/preview.js">`, which reloads the page (keeping its scroll position) whenever the editor saves, and passes ⌘S back to the editor.

A forged or expired cookie is ignored: the request is a normal visit.

Only framed pages preview. The floating window is a frame, and so is the pop-out (see below). A page opened in a tab of its own (`Sec-Fetch-Dest: document`) is always the live site, even in the browser that holds the cookie. Saving shows up in the preview; only publishing changes the site. Browsers that don't send `Sec-Fetch-Dest` (older than Safari 16.4) preview wherever the cookie goes.

## What your site needs

- Requests must go through `vibe({ fetch })`, as in `vibe-cms docs astro` and `vibe-cms docs getting-started`. Sites that route with `vibe.match` and `vibe.handle` themselves don't get preview mode.
- The `nodejs_compat` compatibility flag, which <span style="white-space: nowrap">Vibe CMS</span> already requires. The preview scope uses `AsyncLocalStorage`.
- Your own caches (KV, `caches.default`, in-memory memoization) should be skipped in preview. Check with `isPreview()`:

```ts
import { isPreview } from "vibe-cms/handler";

if(!isPreview()) await cache.put(request, response.clone());
```

## Blocks

In preview, `<Blocks>` from `vibe-cms/blocks/astro` marks where each block starts with an HTML comment (`<!--vibe-block:N-->`). Each block in the editor then has **Show in preview**, which scrolls the preview to that block and outlines it. The block is shown as last saved. The markers only exist in preview responses. The React `Blocks` doesn't add them yet.

### Picking in the preview

The pointer button in the preview's title bar turns on the picker. Hovering the page outlines the block or field under the pointer and names it ("Pricing › Monthly"). Clicking opens it in the editor: the right document (even from another page of the editor), the block's card (opened if it was collapsed), and the field, which scrolls into view, takes focus and flashes. Clicks on the page do nothing else while picking. Escape in the preview, or the button again, turns it off. It stays on as the preview reloads after saves.

Components need nothing for this. Turning the picker on makes one extra request for the page in the background, with an `x-vibe-pick: 1` header, and reads it without showing it:

- `<Blocks>` renders each block again for each of its text and number fields, with that field changed (`Ж` in front of text, numbers plus one), into `<template>` elements. Booleans, `type`, `kind` and `id` stay as they are. Past 30 fields, a block's variants change a list item or an object at a time.
- The preview script compares each variant with the block as rendered. Whatever changed shows that field, however the component transforms it: uppercased, truncated, joined with other text, used in a class or a URL. A render that differs between two unchanged copies (random ids, timestamps) is ignored.
- `vibe.client(env)` notes which document each value in a query result came from, so `<Blocks>` can say which document its blocks belong to.

The page on screen is never changed. With the picker off, nothing runs and nothing extra is rendered.

Limits:

- Without `field()` marks (below), only blocks rendered by `<Blocks>` from `vibe-cms/blocks/astro` can be picked. The React `Blocks` doesn't support it yet.
- A field that doesn't change anything you can see (a boolean, a setting the component only uses for layout of things it renders the same) picks the block.
- Where a block's list came from another query or was rebuilt (`blocks.filter(…)`), the picker can't tell its document, and opens the block in the open document's blocks instead, like **Show in preview**.
- A variant whose changed value makes its component throw is skipped. So is a component that renders differently each time, as far as it does.
- Rich text picks the whole rich text field.
- The built-in blocks mark their own fields, so they're exact without the comparison.
- Picking shows content as last saved. Unsaved edits that move blocks around may point a pick at the wrong block until you save.
- The background render runs every block once per field. That's quick for normal pages (about 60 ms for a page of 11 blocks in development), but a page with many large blocks takes longer before fields can be picked. Blocks can be picked before then.

### Marking fields yourself

Anything else on a page (a post's title, its author, a header from site settings) can be picked once its element says which field it shows, with `field()` from `vibe-cms/preview`:

```astro
---
import { field } from "vibe-cms/preview";

const entry = await cms.query(post).findFirst({ where: eq(post.slug, slug), with: { author: true } });
---
<h1 data-vibe-field={field(entry, "title")}>{entry.title}</h1>
<span data-vibe-field={field(entry.author, "name")}>{entry.author.name}</span>
<div data-vibe-field={field(entry, "body")} set:html={renderRichText(entry.body)} />
<p data-vibe-field={field(entry, "faq", 2, "answer")}>{entry.faq[2].answer}</p>
```

- The first argument is an object or array straight from `vibe.client(env)`: `field()` looks it up to find its document. An expanded reference (`entry.author`) is its own document, so clicking the name opens the author.
- The rest is the path to the field, one argument per step, checked against the value's type: `field(entry, "titel")` doesn't compile. Leave it out to mark the whole object: `field(item)`.
- Outside a preview, and for copies (`{ ...entry }`, items of `.map()` results you built yourself), it's `undefined`, which Astro and React leave out. The live site's HTML doesn't change, and the picker falls back to what it works out by itself.

For lists you filter or sort, `field.entries()` keeps each item's place in the document:

```astro
{field.entries(entry.faq).filter(([item]) => item.featured).map(([item, attr]) => (
  <details data-vibe-field={attr()}>
    <summary data-vibe-field={attr("question")}>{item.question}</summary>
    <p data-vibe-field={attr("answer")}>{item.answer}</p>
  </details>
))}
```

A plain `.map()` over the original list doesn't need it: `field(item, "answer")` works on each item.

Marks win over the picker's own mapping where they're closer to what was clicked, and the other way round. Inside a block component, its props are a copy, so `field(Astro.props, …)` gives `undefined`. Blocks don't need marks: the picker maps them itself. Use `field()` in server-rendered markup: in a hydrated island it's `undefined` in the browser, and React would warn about the difference.

## Where it opens

- **Floating window**: drag it by its title bar and it settles into the nearest corner. Resize it from any edge or corner. It always stays on screen.
  - **Follow the editor** (in its **⋯** menu, with Reload and Open in a new window) makes it show each document's page as you move around the editor, if the document has one (a `preview` URL), as last saved. Pages without one leave it where it is. The setting is remembered per browser.
  - Push it past the bottom-right corner and it tucks away, showing only its top-left, like a macOS Quick Note. Hovering leans it out a little. Click it or drag it out to bring it back. Opening the preview from the editor, or **Show in preview** on a block, brings it back too.
  - **Freeform**: the page fills the window at the chosen zoom. Switching to Freeform keeps the current zoom, so nothing jumps.
  - **Fixed**: the page's viewport keeps one size at any window size. Pick a ratio (16:9, 16:10, 4:3, 3:2, 1:1, a 9:19.5 phone, or your own `W : H`), or a real device under **Devices** (searchable, recent devices first): an iPhone 17 Pro is 402 × 681, its browser viewport. **Rotate** swaps the sides. The zoom is **Fit** (to the window), or a set zoom that sizes the window to the page, as far as the screen allows.
  - The title bar shows the zoom. Click it for the page's size, a slider (25 to 200%), a field for any zoom from 10 to 400%, and 50%, 75% and 100% (plus Fit, for fixed shapes).
  - Shape, size, zoom and corner are remembered per browser.

  Device sizes come from Playwright's device list (`scripts/devices.ts` writes `src/admin/app/devices.json`; `bun run devices` after bumping `playwright-core`, which a test checks). The preview matches a device's viewport, not its user agent, pixel density or touch input: test those on the device.
- **New window** (in the **⋯** menu): a separate browser window, for a second screen. It's a small page under `{prefix}/preview/window` with the site in a frame filling it, so it previews like the floating one. It keeps reloading on saves. A badge says it's a preview, with **Exit**, which clears the cookie and opens the live page.

Inside a panel on another domain, the floating window's cookie is a third-party cookie, sent with `SameSite=None; Partitioned` so it stays with that panel. Browsers that block those (Safari) can't sign the floating window in, so it offers **Open in a new window** instead. Local development (plain HTTP, panel and site on `localhost`) uses `SameSite=Lax` and works everywhere.

## Limits

- The preview shows saved drafts. Unsaved edits appear once you save.
- Blocks your saved changes add, change or move are outlined, against the live page (New, Changed, Moved). Only the first block list on a page is outlined. Turn it off with "Outline unpublished changes" in the preview's menu.
- Saves from agents, the CLI or the REST API don't reload open previews. Reload them with the preview's reload button.
- A draft can be incomplete (only publishing validates). Site code that assumes required fields are present may fail on one in preview.
