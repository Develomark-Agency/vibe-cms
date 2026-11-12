import { z } from "zod";
import { base, router } from "../define.ts";
import { limit, offset, type } from "./fields.ts";

const id = z.string().describe("Redirect ID, from `redirects.list`");
const from = z.string().describe("The old path: `/old-page`, or `/blog/*` to match everything under /blog/");
const to = z.string().describe("Where it goes: a path like `/new-page`, a full URL, or with a wildcard `from`, `*` for what it matched (`/news/*`)");
const status = z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).optional().describe("301 (permanent, the default), 302, 307 or 308");
const keepQuery = z.boolean().optional().describe("Pass the visitor's query string on to the target. Default true");
const locale = z.string().nullable().optional().describe("A label for the language the page was in; matching is on the path alone");

const rule = { from, to, status, keepQuery, locale };

const redirectsList = base({
  summary: "List redirects",
  description: "The site's redirects, newest first: where each goes, its status, how often it has been used and where it came from (`manual`, or `slug-change` / `trash` for ones made when a page's address changed or it was deleted, with the `documentId`). `search` matches the from and to paths. `hasUrls` says whether any content type has pages the CMS can find the address of.",
  readOnly: true
})
  .input(z.object({
    search: z.string().optional(),
    source: z.enum(["manual", "slug-change", "trash"]).optional(),
    limit,
    offset
  }))
  .handler(({ context: { engine }, input }) => engine.listRedirects({ search: input.search, source: input.source, limit: input.limit ?? 50, offset: input.offset ?? 0 }));

const redirectsCreate = base({
  summary: "Add a redirect",
  description: "Sends visitors from one path to another before the site's own pages are looked up. Matching is exact, or one trailing `*` that carries over to `to`; exact rules win, then the longest wildcard. Fails with CONFLICT for a path that already has a redirect or one that would loop. Rules that already led to `from` are re-pointed to `to`, so visitors never take more than one hop. `warnings` says when `from` is a live page the redirect hides."
})
  .input(z.object(rule).extend({
    from: from.describe(from.description!),
    deletedDocument: z.object({ id: z.string(), type }).optional().describe("The page this redirect replaces, just moved to the trash. Restoring it from the trash then removes the redirect")
  }))
  .handler(({ context: { engine }, input }) => engine.createRedirect(input));

const redirectsUpdate = base({
  summary: "Change a redirect",
  description: "Changes any of a redirect's from, to, status, keepQuery or locale. The same checks as adding one.",
  idempotent: true
})
  .input(z.object({ id, from: from.optional(), to: to.optional(), status, keepQuery, locale }))
  .handler(({ context: { engine }, input: { id: redirect, ...patch } }) => engine.updateRedirect(redirect, patch));

const redirectsDelete = base({
  summary: "Delete a redirect",
  description: "Removes a redirect. Visitors to the old path get the site's own response again."
})
  .input(z.object({ id }))
  .handler(({ context: { engine }, input }) => engine.deleteRedirect(input.id));

const redirectsImport = base({
  summary: "Import redirects",
  description: "Adds many redirects at once, up to 5000, such as when moving a site onto this one. Rows that can't be added (a path that already has a redirect, a loop, a bad path) are skipped and returned in `skipped` with the reason; the rest are added."
})
  .input(z.object({ rows: z.array(z.object(rule)).max(5000) }))
  .handler(({ context: { engine }, input }) => engine.importRedirects(input.rows));

const redirectsSuggest = base({
  summary: "Suggest a redirect for a document",
  description: "When publishing would change the address of a page (its slug or path changed), the old and new address and whether the old one already has a redirect; null when the address isn't changing or the content type has no pages the CMS can find the address of (`hasUrl` says which); `url` is where the live page is now. Pass `redirect: true` to `documents.publish` to add it.",
  readOnly: true
})
  .input(z.object({ type, id: z.string(), locale: z.string().optional() }))
  .handler(async ({ context: { engine }, input }) => ({ suggestion: await engine.suggestRedirect(input.type, input.id, input.locale), hasUrl: engine.hasUrl(input.type), url: await engine.currentUrl(input.type, input.id, input.locale) }));

export const redirects = router({
  list: redirectsList,
  create: redirectsCreate,
  update: redirectsUpdate,
  delete: redirectsDelete,
  import: redirectsImport,
  suggest: redirectsSuggest
});
