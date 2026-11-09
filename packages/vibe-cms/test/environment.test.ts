import { describe, expect, test } from "bun:test";
import { createHandler } from "../src/handler/index.ts";
import { config } from "./fixture.ts";
import { createD1 } from "./helpers.ts";

/** `VIBE_ENV`: anything but production stays out of search engines. */

function site(options: { env?: Record<string, unknown>, dev?: boolean } = {}) {
  const vibe = createHandler(config, { dev: options.dev ?? false, bindings: (e: { DB: ReturnType<typeof createD1> }) => ({ db: e.DB }) });
  const worker = vibe({
    fetch: async request => new URL(request.url).pathname === "/robots.txt"
      ? new Response("User-agent: *\nAllow: /\n")
      : new Response("the site's own page", { headers: { "content-type": "text/html" } })
  });
  const env = { DB: createD1(), ...options.env };
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  return { vibe, env, get: (path: string) => worker.fetch(new Request(`https://site.test${path}`), env, ctx) };
}

describe("VIBE_ENV", () => {
  test("unset, a deployed site is production and its responses are left alone", async () => {
    const { vibe, env, get } = site();
    expect(vibe.environment(env)).toBe("production");
    const page = await get("/");
    expect(page.headers.get("x-robots-tag")).toBeNull();
    expect(await (await get("/robots.txt")).text()).toContain("Allow: /");
  });

  test("unset, a development server is development", () => {
    const { vibe, env } = site({ dev: true });
    expect(vibe.environment(env)).toBe("development");
  });

  test("staging pages, and the CMS's own routes, are noindex", async () => {
    const { vibe, env, get } = site({ env: { VIBE_ENV: " Staging " } });
    expect(vibe.environment(env)).toBe("staging");
    const page = await get("/");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(page.headers.get("content-type")).toBe("text/html");
    expect(await page.text()).toBe("the site's own page");
    expect((await get("/.well-known/vibe-cms")).headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("staging's robots.txt disallows everything, whatever the site's own says", async () => {
    const robots = await site({ env: { VIBE_ENV: "staging" } }).get("/robots.txt");
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  test("VIBE_ENV=production behaves like unset", async () => {
    const page = await site({ env: { VIBE_ENV: "production" } }).get("/");
    expect(page.headers.get("x-robots-tag")).toBeNull();
  });

  test("a value that isn't a name is refused", () => {
    const { vibe, env } = site({ env: { VIBE_ENV: "my staging!" } });
    expect(() => vibe.environment(env)).toThrow(/isn't a name/);
  });
});
