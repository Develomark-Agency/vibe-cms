# Draft preview

Editors see the site with their saved drafts in a floating window over the editor, or in a window of its own. The preview reloads whenever anything is saved, not only published.

## How it works

1. The editor's **Preview** (in the sidebar, the command palette, or the eye button on a document with a `preview` URL) asks the site for a one-time code and opens `{prefix}/preview?code=…&path=/…`.
2. The site trades the code for a `vibe_preview` cookie (the editor's session, `HttpOnly`, valid for the session's 12 hours) and redirects to the page.
3. `vibe({ fetch })` sees the cookie and runs your `fetch` inside a preview scope. There, `vibe.client(env)` reads drafts of every type the editor can read. Pages, FAQs, settings and references all show their saved drafts, including documents never published, with no changes to your site's code.
4. Preview responses are `Cache-Control: no-store` and `X-Robots-Tag: noindex`. HTML pages get `<script src="{prefix}/preview.js">`, which reloads the page (keeping its scroll position) whenever the editor saves, and passes ⌘S back to the editor.

A forged or expired cookie is ignored: the request is a normal visit.

## What your site needs

- Requests must go through `vibe({ fetch })`, as in `vibe-cms docs astro` and `vibe-cms docs getting-started`. Sites that route with `vibe.match` and `vibe.handle` themselves don't get preview mode.
- The `nodejs_compat` compatibility flag, which vibe-cms already requires. The preview scope uses `AsyncLocalStorage`.
- Your own caches (KV, `caches.default`, in-memory memoization) should be skipped in preview. Check with `isPreview()`:

```ts
import { isPreview } from "vibe-cms/handler";

if(!isPreview()) await cache.put(request, response.clone());
```

## Blocks

In preview, `<Blocks>` from `@vibe-cms/blocks/astro` marks where each block starts with an HTML comment (`<!--vibe-block:N-->`). Each block in the editor then has **Show in preview**, which scrolls the preview to that block and outlines it. The block is shown as last saved. The markers only exist in preview responses. The React `Blocks` doesn't add them yet.

## Where it opens

- **Floating window**: drag it by its title bar and it settles into the nearest corner. Resize it from any edge or corner. It always stays on screen.
  - Push it past the bottom-right corner and it tucks away, showing only its top-left, like a macOS Quick Note. Hovering leans it out a little. Click it or drag it out to bring it back. Opening the preview from the editor, or **Show in preview** on a block, brings it back too.
  - **Freeform**: the page fills the window at the chosen zoom (100%, 75% or 50%). Switching to Freeform keeps the current zoom, so nothing jumps.
  - **Fixed**: the page's viewport keeps one size at any window size. Pick a ratio (16:9, 16:10, 4:3, 3:2, 1:1, a 9:19.5 phone, or your own `W : H`), or a real device under **Devices** (searchable, recent devices first): an iPhone 17 Pro is 402 × 681, its browser viewport. **Rotate** swaps the sides. The zoom is **Fit to window**, or a set zoom that sizes the window to the page.
  - The title bar shows the zoom; its menu shows the page's size.
  - Shape, size, zoom and corner are remembered per browser.

  Device sizes come from Playwright's device list (`scripts/devices.ts` writes `src/admin/app/devices.json`; `bun run devices` after bumping `playwright-core`, which a test checks). The preview matches a device's viewport, not its user agent, pixel density or touch input: test those on the device.
- **New window** (the arrow button): a separate browser window, for a second screen. It gets its own cookie and keeps reloading on saves. A badge on the page says it's a preview, with **Exit**, which clears the cookie.

Inside a panel on another domain, the floating window's cookie is a third-party cookie, sent with `SameSite=None; Partitioned` so it stays with that panel. Browsers that block those (Safari) can't sign the floating window in, so it offers **Open in a new window** instead. Local development (plain HTTP, panel and site on `localhost`) uses `SameSite=Lax` and works everywhere.

## Limits

- The preview shows saved drafts. Unsaved edits appear once you save.
- Saves from agents, the CLI or the REST API don't reload open previews. Reload them with the preview's reload button.
- A draft can be incomplete (only publishing validates). Site code that assumes required fields are present may fail on one in preview.
