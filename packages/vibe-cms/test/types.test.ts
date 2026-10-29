import { expect, test } from "bun:test";
import { defineConfig, definePlugin, defineWidget, type Infer, type InferOutput } from "../src/index.ts";
import { createHandler } from "../src/handler/index.ts";
import { image } from "../src/media/index.ts";
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
