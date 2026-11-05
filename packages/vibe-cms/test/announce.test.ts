import { describe, expect, test } from "bun:test";
import { createHandler } from "../src/handler/index.ts";
import { config } from "./fixture.ts";
import { createD1 } from "./helpers.ts";

/** What a new site prints, and when. */

async function visit(url: string, options: { env?: Record<string, unknown>, dev?: boolean } = {}) {
  const vibe = createHandler(config, { dev: options.dev ?? false, bindings: (e: { DB: ReturnType<typeof createD1> }) => ({ db: e.DB }) });
  const worker = vibe({ fetch: async () => new Response("the site's own page") });
  const env = { DB: createD1(), ...options.env };
  const pending: Array<Promise<unknown>> = [];
  const ctx = { waitUntil: (work: Promise<unknown>) => void pending.push(work), passThroughOnException() {} } as never;
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    const response = await worker.fetch(new Request(url), env, ctx);
    await Promise.all(pending);
    return { response, lines: lines.join("\n"), env, worker, ctx, pending };
  } finally {
    console.log = log;
  }
}

describe("a new site's links", () => {
  test("a visit to the site's own homepage prints the setup and claim links", async () => {
    const { response, lines } = await visit("https://new-site.test/");
    expect(await response.text()).toBe("the site's own page");
    expect(lines).toMatch(/https:\/\/new-site\.test\/_vibe\/admin\/#claim=\S+/);
    expect(lines).toMatch(/https:\/\/new-site\.test\/_vibe\/admin\/#setup=\S+/);
  });

  test("the links are printed once per Worker instance, not on every page", async () => {
    const first = await visit("https://new-site.test/");
    expect(first.lines).toContain("#claim=");
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const pending: Array<Promise<unknown>> = [];
      const ctx = { waitUntil: (work: Promise<unknown>) => void pending.push(work) } as never;
      await first.worker.fetch(new Request("https://new-site.test/about"), first.env, ctx);
      await Promise.all(pending);
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).not.toContain("#claim=");
  });

  test("a site that belongs to an org prints nothing", async () => {
    const { lines } = await visit("https://org-site.test/", { env: { VIBE_ORG: "https://hub.test" } });
    expect(lines).not.toContain("#claim=");
    expect(lines).not.toContain("#setup=");
  });

  test("a development server prints nothing", async () => {
    expect((await visit("https://localhost:1337/", { dev: true })).lines).not.toContain("#claim=");
  });
});

describe("printing the links again on request", () => {
  async function announce(worker: Awaited<ReturnType<typeof visit>>["worker"], env: { DB: ReturnType<typeof createD1> }, origin = "https://new-site.test") {
    const pending: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (work: Promise<unknown>) => void pending.push(work) } as never;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const response = await worker.fetch(new Request(`${origin}/_vibe/api/org/announce`, { method: "POST" }), env, ctx);
      await Promise.all(pending);
      return { body: await response.json() as { announced: boolean, reason?: string }, lines: lines.join("\n") };
    } finally {
      console.log = log;
    }
  }

  test("prints both links again, never puts them in the reply, and says how to print them", async () => {
    const first = await visit("https://new-site.test/");
    const token = first.lines.match(/#claim=(\S+)/)![1]!;
    await new Promise(resolve => setTimeout(resolve, 1100));
    const again = await announce(first.worker, first.env);
    expect(again.body).toEqual({ announced: true });
    expect(JSON.stringify(again.body)).not.toContain(token);
    // The same one-time token, not a new one.
    expect(again.lines).toContain(`#claim=${token}`);
    expect(again.lines).toMatch(/#setup=\S+/);
    expect(again.lines).toContain("vibe-cms admin claim-link https://new-site.test");
  });

  test("a loop of requests is held to one print a second", async () => {
    const first = await visit("https://new-site.test/");
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect((await announce(first.worker, first.env)).body.announced).toBe(true);
    const second = await announce(first.worker, first.env);
    expect(second.body.announced).toBe(false);
    expect(second.lines).toBe("");
  });

  test("a site in an org, or with its own owners, says so and prints nothing", async () => {
    const inOrg = await visit("https://org-site.test/", { env: { VIBE_ORG: "https://hub.test" } });
    const refused = await announce(inOrg.worker, inOrg.env);
    expect(refused.body).toEqual({ announced: false, reason: "This site already belongs to an org" });
    expect(refused.lines).toBe("");

    const owned = await visit("https://owned.test/");
    await (owned.env.DB as ReturnType<typeof createD1>).prepare("INSERT INTO vibe_users (id, email, roles, created_at, created_by) VALUES ('u1', 'o@x.test', '[\"owner\"]', 0, 'setup')").run();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect((await announce(owned.worker, owned.env)).body.reason).toContain("own owners");
  });
});
