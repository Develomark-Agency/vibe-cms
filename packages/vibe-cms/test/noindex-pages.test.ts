import { beforeEach, describe, expect, test } from "bun:test";
import { defineConfig } from "../src/index.ts";
import { createHandler } from "../src/handler/index.ts";
import { pageSchema } from "../src/blocks/index.ts";
import v from "../src/schema/index.ts";
import { createD1, ctx } from "./helpers.ts";

/** Pages editors set to "Hide from search results" get `X-Robots-Tag: noindex`. */

const config = defineConfig({
  collections: {
    page: { schema: pageSchema() },
    post: {
      url: "/blog/{slug}",
      schema: v.object({
        title: v.text({ min: 1 }),
        slug: v.text({ format: "slug", indexed: true, unique: true }),
        visibility: v.optional(v.enum(["public", "noindex"]))
      })
    },
    note: { schema: v.object({ title: v.text({ min: 1 }) }) }
  }
});

function setup() {
  const env = { DB: createD1(), VIBE_ENV: "production", VIBE_ORG: "https://hub.test" };
  const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB }) });
  const worker = vibe({ fetch: async () => new Response("site") });
  let token = "";
  async function api(path: string, init: { method?: string, json?: unknown } = {}) {
    const headers = new Headers();
    if(token) headers.set("authorization", `Bearer ${token}`);
    if(init.json !== undefined) headers.set("content-type", "application/json");
    const response = await vibe.handle(new Request(`https://site.test/_vibe${path}`, { method: init.method, headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined }), env, ctx as never);
    return { status: response.status, body: await response.json() as any };
  }
  const visit = (path: string, method = "GET") => worker.fetch(new Request(`https://site.test${path}`, { method }), env, ctx as never);
  return { env, api, visit, signIn: async () => { token = (await api("/api/session", { method: "POST", json: { dev: true } })).body.token; } };
}

let t: ReturnType<typeof setup>;
beforeEach(async () => {
  t = setup();
  await t.signIn();
});

const page = (path: string, visibility?: string, publish = true) =>
  t.api("/api/documents/page", { method: "POST", json: { data: { title: "Page", path, ...(visibility ? { visibility } : {}), blocks: [] }, publish } });

describe("hidden pages", () => {
  test("a published page set to noindex gets the header; other pages don't", async () => {
    await page("/secret", "noindex");
    await page("/open", "public");
    await page("/plain");
    expect((await t.visit("/secret")).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await t.visit("/secret/")).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await t.visit("/open")).headers.get("x-robots-tag")).toBeNull();
    expect((await t.visit("/plain")).headers.get("x-robots-tag")).toBeNull();
    expect((await t.visit("/nowhere")).headers.get("x-robots-tag")).toBeNull();
  });

  test("HEAD gets it too, a POST doesn't need it", async () => {
    await page("/secret", "noindex");
    expect((await t.visit("/secret", "HEAD")).headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("an unpublished draft isn't hidden yet", async () => {
    await page("/draft", "noindex", false);
    expect((await t.visit("/draft")).headers.get("x-robots-tag")).toBeNull();
  });

  test("other content types hide their pages at their own address", async () => {
    await t.api("/api/documents/post", { method: "POST", json: { data: { title: "Hi", slug: "hi", visibility: "noindex" }, publish: true } });
    expect((await t.visit("/blog/hi")).headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("the CMS's own routes are left alone", async () => {
    await page("/secret", "noindex");
    const response = await t.visit("/.well-known/vibe-cms");
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });
});
