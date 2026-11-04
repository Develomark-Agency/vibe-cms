import { expect, test } from "bun:test";
import { defineConfig, definePlugin, defineWidget, type Infer, type InferOutput } from "../src/index.ts";
import { createHandler } from "../src/handler/index.ts";
import { defineServer } from "../src/server/index.ts";
import { image } from "../src/media/index.ts";
import { field } from "../src/preview/index.ts";
import v from "../src/schema/index.ts";
import type { D1 } from "../src/handler/platform.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<T extends true>(value: T) {
  return value;
}

const Rich = defineWidget<Array<{ kind: "p", text: string }>, { toolbar?: "minimal" }>({
  id: "@test/rich",
  admin: async () => ({})
});

test("widgets are typed against field values", () => {
  // @ts-expect-error Rich edits paragraphs, the field value is a string
  v.text({ widget: Rich() });
  v.array(v.object({ kind: v.literal("p"), text: v.text() }), { widget: Rich({ toolbar: "minimal" }) });
  expect(true).toBe(true);
});

test("content types are inferred from the config", () => {
  const config = defineConfig({
    schemas: {
      post: v.object({
        title: v.text(),
        subtitle: v.optional(v.text()),
        layout: v.enum(["default", "wide"]),
        author: v.ref("author"),
        cover: image()
      }),
      author: v.object({ name: v.text() })
    }
  });
  type Post = Infer<typeof config.schemas.post>;
  assertType<Equal<Post["subtitle"], string | undefined>>(true);
  assertType<Equal<Post["layout"], "default" | "wide">>(true);
  assertType<Equal<Post["author"], string>>(true);
  assertType<Equal<Post["cover"], { asset: string, alt: string, focal?: { x: number, y: number } }>>(true);
  type Out = InferOutput<typeof config.schemas.post>;
  assertType<Equal<Out["cover"]["url"], string>>(true);
  expect(true).toBe(true);
});

test("plugin binding contracts flow into createHandler", () => {
  interface KV { get(key: string): Promise<string | null> }
  const Search = definePlugin<{ cache: KV }>()(() => ({ name: "search", options: {} }));
  const config = defineConfig({ plugins: [Search()], schemas: { post: v.object({ title: v.text() }) } });
  const db = {} as D1;
  const cache = {} as KV;
  createHandler(config, { bindings: () => ({ db, search: { cache } }) });
  // @ts-expect-error Property 'search' is missing
  createHandler(config, { bindings: () => ({ db }) });
  expect(true).toBe(true);
});

test("hooks are typed per content type when given the site's config", () => {
  const Audit = definePlugin()(() => ({ name: "audit", options: {} }));
  const site = defineConfig({
    schemas: {
      post: v.object({ title: v.text(), words: v.optional(v.number({ readOnly: true })) }),
      author: v.object({ name: v.text() })
    }
  });
  defineServer<typeof Audit, typeof site>(() => ({
    "content.beforeWrite": (_input, output) => {
      if(output.type === "post" && output.valid) {
        output.doc.words = output.doc.title.split(" ").length;
        // @ts-expect-error not a field of posts
        output.doc.wordz = 1;
      }
      if(output.type === "author" && output.valid) {
        // @ts-expect-error authors have no title
        void output.doc.title;
      }
      if(!output.valid) {
        // Drafts that don't validate are plain JSON.
        void output.doc.anything;
      }
    }
  }));
  // @ts-expect-error "pots" isn't a content type
  defineServer<typeof Audit, typeof site>(() => ({ "content.beforeDelete": ({ type }) => void (type === "pots") }));
  expect(true).toBe(true);
});

test("config strings are checked against the config's own schemas", () => {
  const schemas = {
    post: v.object({ title: v.text(), slug: v.text(), views: v.number(), author: v.ref("author") }),
    author: v.object({ name: v.text() })
  };
  defineConfig({
    locales: ["en", "fr"],
    defaultLocale: "fr",
    schemas,
    collections: {
      post: { title: "title", icon: "newspaper", preview: "/{locale}/posts/{slug}" },
      author: { icon: "user-round" }
    },
    permissions: {
      roles: { editor: { post: ["read", "write"], write: { locales: ["fr"] } } },
      users: { "jane@example.com": ["editor"] }
    }
  });
  // @ts-expect-error not an icon
  defineConfig({ schemas, collections: { post: { icon: "ajlkwerjawl" } } });
  // @ts-expect-error `views` is a number, not a text field
  defineConfig({ schemas, collections: { post: { title: "views" } } });
  // @ts-expect-error `slugg` isn't a field
  defineConfig({ schemas, collections: { post: { preview: "/posts/{slugg}" } } });
  // @ts-expect-error "pots" isn't a content type
  defineConfig({ schemas, collections: { pots: { icon: "file" } } });
  // @ts-expect-error "de" isn't one of the locales
  defineConfig({ locales: ["en", "fr"], defaultLocale: "de", schemas });
  // @ts-expect-error roles can only name content types
  defineConfig({ schemas, permissions: { roles: { editor: { pots: ["read"] } } } });
  // @ts-expect-error users can only be given roles that exist
  defineConfig({ schemas, permissions: { roles: { editor: { post: ["read"] } }, users: { "a@b.c": ["admin"] } } });
  // @ts-expect-error v.ref("authr") points at nothing
  defineConfig({ schemas: { post: v.object({ author: v.ref("authr") }), author: v.object({ name: v.text() }) } });
  expect(true).toBe(true);
});

test("query locales are the site's locales", () => {
  const site = defineConfig({ locales: ["en", "fr"], schemas: { post: v.object({ title: v.text() }) } });
  const cms = createHandler(site, { bindings: () => ({ db: {} as D1 }) }).client({});
  void cms.query(site.schemas.post).findMany({ locale: "fr" });
  // @ts-expect-error "de" isn't one of the site's locales
  void cms.query(site.schemas.post).findMany({ locale: "de" });
  expect(true).toBe(true);
});

test("action clients are typed from the action definitions", async () => {
  const { createActionClient } = await import("../src/actions/client.ts");
  type Actions = import("../src/actions/core.ts").CoreActions;
  const calls: string[] = [];
  const actions = createActionClient<Actions>(async name => {
    calls.push(name);
    return { docs: [], total: 0 };
  });
  const listed = await actions.documents.list({ type: "post", limit: 5 });
  assertType<Equal<typeof listed.total, number>>(true);
  // @ts-expect-error `type` is required
  void actions.documents.list({ limit: 5 });
  // @ts-expect-error not an action
  void actions.documents.nope;
  void actions.schema.list();
  expect(calls).toEqual(["documents.list", "documents.list", "schema.list"]);
});

test("field() paths are checked against the value", () => {
  type Post = { id: string, title: string, cover?: { url: string, alt?: string } | null, faq: Array<{ question: string, answer: string, links: Array<{ href: string }> }>, tags: string[], $meta: { locale: string } };
  const post: Post = { id: "p", title: "Hi", cover: null, faq: [{ question: "Q", answer: "A", links: [] }], tags: ["x"], $meta: { locale: "en" } };
  field(post);
  field(post, "title");
  field(post, "faq", 0, "answer");
  field(post, "faq", 0, "links", 0, "href");
  field(post, "cover", "url");
  field(post.cover, "alt");
  field(post, "tags", 0);
  // @ts-expect-error not a field
  field(post, "titel");
  // @ts-expect-error not a field of an item
  field(post, "faq", 0, "nope");
  // @ts-expect-error strings have no fields
  field(post, "title", "x");
  // @ts-expect-error $meta isn't content
  field(post, "$meta");
  for(const [item, attr] of field.entries(post.faq)) {
    assertType<Equal<typeof item, Post["faq"][number]>>(true);
    attr("links", 0, "href");
    // @ts-expect-error not a field of an item
    attr("nope");
  }
  // Outside a preview: nothing to mark.
  expect(field(post, "title")).toBeUndefined();
  expect(field.entries(post.tags).map(([, attr, i]) => [attr(), i])).toEqual([[undefined, 0]]);
});
