import type { Infer, InferOutput } from "vibe-cms";
import { and, asc, desc, eq, gte, has, inArray, like, meta, not, or, search, type QueryClient } from "vibe-cms/query";
import fields from "./fields.ts";
import references from "./references.ts";
import localization from "./localization.ts";

// Query code takes a client, so it runs the same in-process (`vibe.client(env)` in the Worker)
// and over HTTP (`createClient({ url })`).
type Cms<C> = QueryClient<C>;

const { event } = fields.schemas;

export async function upcomingEvents(cms: Cms<typeof fields>) {
  return cms.query(event).findMany({
    where: and(
      gte(event.startsAt, new Date()),
      inArray(event.status, ["open", "full"]),
      not(eq(event.online, true))
    ),
    orderBy: [asc(event.startsAt)],
    limit: 20,
    offset: 0
  });
}

export async function eventPage(cms: Cms<typeof fields>, slug: string) {
  const found = await cms.query(event).findFirst({ where: eq(event.slug, slug) });
  if(!found) return null;
  // Every result has its `id` and `$meta`: locale, createdAt, updatedAt, publishedAt, status.
  return { ...found, lastChanged: found.$meta.updatedAt };
}

export async function filters(cms: Cms<typeof fields>) {
  return cms.query(event).findMany({
    where: or(
      has(event.tags, "workshop"),
      like(event.title, "%summit%"),
      eq(event.venue.name, "Town Hall"),
      search("accessibility")
    ),
    orderBy: [desc(meta.publishedAt)]
  });
}

export async function counts(cms: Cms<typeof fields>) {
  // One round trip for several queries.
  const [open, total] = await cms.batch([
    cms.query(event).count({ where: eq(event.status, "open") }),
    cms.query(event).count()
  ]);
  return { open, total };
}

// Working copies instead of published content. Needs a trusted client: in-process, or HTTP with a token.
export async function drafts(cms: Cms<typeof fields>) {
  return cms.query(event, { drafts: true }).findMany({ orderBy: [desc(meta.updatedAt)] });
}

const { post, author } = references.schemas;

export async function postsWithAuthors(cms: Cms<typeof references>) {
  // `with` replaces the stored ID with the referenced document.
  const posts = await cms.query(post).findMany({ with: { author: true, categories: { with: { parent: true } } } });
  return posts.map(p => ({ title: p.title, by: p.author?.name, in: p.categories.map(c => c.parent?.name ?? c.name) }));
}

export async function authorWithPosts(cms: Cms<typeof references>, id: string) {
  // A reverse expansion is named after the type that points here: `posts` finds posts whose `author` is this one.
  return cms.query(author).findById(id, { with: { posts: { orderBy: [desc(meta.publishedAt)], limit: 5 } } });
}

const { page } = localization.schemas;

export async function frenchPage(cms: Cms<typeof localization>, path: string) {
  // Falls back to English for pages without a French translation; `$meta.locale` says which you got.
  const found = await cms.query(page).findFirst({ where: eq(page.path, path), locale: "fr" });
  return found && { ...found, translated: found.$meta.locale === "fr" };
}

// The stored shape (what you write) and the query shape (what you read).
export type EventInput = Infer<typeof event>;
export type EventResult = InferOutput<typeof event>;
