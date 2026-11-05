import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { attach } from "../src/cli/attach.ts";
import { claimLinkFor, findDatabase, findWorker, siteOrigin, type ClaimLookup } from "../src/cli/claim.ts";
import type { Binding } from "../src/cli/deploy/cloudflare.ts";
import { createHandler } from "../src/handler/index.ts";
import { config } from "./fixture.ts";
import { createD1 } from "./helpers.ts";

/** A claim link for a site you can't see the logs of: from its address, through Cloudflare, to its database. */

const accounts = [{ id: "acc1", name: "Agency" }];

interface World {
  workers?: Record<string, string[]>,
  subdomain?: string,
  domains?: Array<{ hostname: string, worker: string }>,
  bindings?: Record<string, Binding[]>,
  /** Rows by database id. */
  claims?: Record<string, string | undefined>
}

function lookup(world: World, announce: { announced: boolean, reason?: string } | number = { announced: true }) {
  const queries: Array<{ database: string, sql: string, params: unknown[] }> = [];
  const calls: string[] = [];
  const result: ClaimLookup = {
    accounts,
    async fetch(input, init) {
      calls.push(`${init?.method} ${input}`);
      return typeof announce === "number" ? new Response("no", { status: announce }) : Response.json(announce);
    },
    api: {
      workers: async (account: string) => world.workers?.[account] ?? [],
      subdomain: async () => world.subdomain ?? null,
      allDomains: async () => world.domains ?? [],
      bindings: async (_: string, worker: string) => world.bindings?.[worker] ?? [],
      d1Query: async (_account: string, database: string, sql: string, params: unknown[] = []) => {
        queries.push({ database, sql, params });
        const value = world.claims?.[database];
        return value === undefined ? [] : [{ value }];
      }
    } as ClaimLookup["api"]
  };
  return { lookup: result, queries, calls };
}

function d1(name: string, id: string): Binding {
  return { type: "d1", name, id };
}

afterEach(() => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
});

describe("finding the Worker behind an address", () => {
  test("a workers.dev address names the Worker, if the account's subdomain matches", async () => {
    const { lookup: l } = lookup({ subdomain: "agency" });
    expect(await findWorker(l, "blog-site.agency.workers.dev")).toEqual({ account: "acc1", worker: "blog-site" });
    await expect(findWorker(l, "blog-site.someone-else.workers.dev")).rejects.toThrow("Couldn't find which Worker serves");
  });

  test("a custom domain is looked up among the account's", async () => {
    const { lookup: l } = lookup({ domains: [{ hostname: "client.com", worker: "client-site" }] });
    expect(await findWorker(l, "client.com")).toEqual({ account: "acc1", worker: "client-site" });
    await expect(findWorker(l, "other.com")).rejects.toThrow("--worker");
  });

  test("--worker names it directly, and has to exist", async () => {
    const { lookup: l } = lookup({ workers: { acc1: ["routed-site"] } });
    expect(await findWorker(l, "client.com", { worker: "routed-site" })).toEqual({ account: "acc1", worker: "routed-site" });
    await expect(findWorker(l, "client.com", { worker: "nope" })).rejects.toThrow("No Worker called nope");
  });

  test("looks through every account, or only CLOUDFLARE_ACCOUNT_ID's", async () => {
    const two = lookup({ domains: [{ hostname: "client.com", worker: "w" }] }).lookup;
    two.accounts = [{ id: "a0", name: "Other" }, { id: "acc1", name: "Agency" }];
    two.api = { ...two.api, allDomains: async (id: string) => (id === "acc1" ? [{ hostname: "client.com", worker: "w" }] : []) } as ClaimLookup["api"];
    expect(await findWorker(two, "client.com")).toEqual({ account: "acc1", worker: "w" });
    process.env.CLOUDFLARE_ACCOUNT_ID = "a0";
    await expect(findWorker(two, "client.com")).rejects.toThrow("Couldn't find");
  });
});

describe("choosing the database", () => {
  test("a Worker's only D1 database, or the one bound as DB", async () => {
    const one = lookup({ bindings: { w: [{ type: "r2_bucket", name: "MEDIA" }, d1("CMS", "id-1")] } }).lookup;
    expect(await findDatabase(one, "acc1", "w")).toBe("id-1");
    const several = lookup({ bindings: { w: [d1("ANALYTICS", "id-a"), d1("DB", "id-db")] } }).lookup;
    expect(await findDatabase(several, "acc1", "w")).toBe("id-db");
  });

  test("several with none called DB needs --binding, and says which there are", async () => {
    const l = lookup({ bindings: { w: [d1("A", "id-a"), d1("B", "id-b")] } }).lookup;
    await expect(findDatabase(l, "acc1", "w")).rejects.toThrow("A, B");
    expect(await findDatabase(l, "acc1", "w", { binding: "B" })).toBe("id-b");
    await expect(findDatabase(l, "acc1", "w", { binding: "C" })).rejects.toThrow("no D1 binding called C");
  });

  test("a Worker with no D1 database says so", async () => {
    await expect(findDatabase(lookup({ bindings: { w: [] } }).lookup, "acc1", "w")).rejects.toThrow("no D1");
  });
});

describe("the claim link", () => {
  const world: World = {
    subdomain: "agency",
    bindings: { "blog-site": [d1("DB", "db-1")] },
    claims: { "db-1": "tok123" }
  };

  test("asks the site to make its token, then reads it from the site's database", async () => {
    const { lookup: l, queries, calls } = lookup(world);
    expect(await claimLinkFor("https://blog-site.agency.workers.dev", l)).toBe("https://blog-site.agency.workers.dev/_vibe/admin/#claim=tok123");
    expect(calls).toEqual(["POST https://blog-site.agency.workers.dev/_vibe/api/org/announce"]);
    expect(queries).toEqual([{ database: "db-1", sql: "SELECT value FROM vibe_meta WHERE key = ?", params: ["org_claim"] }]);
  });

  test("takes a bare host", async () => {
    expect(siteOrigin("blog-site.agency.workers.dev")).toBe("https://blog-site.agency.workers.dev");
    expect(await claimLinkFor("blog-site.agency.workers.dev", lookup(world).lookup)).toContain("#claim=tok123");
  });

  test("a site that printed its links a moment ago still has its token", async () => {
    expect(await claimLinkFor("https://blog-site.agency.workers.dev", lookup(world, { announced: false, reason: "Printed a moment ago. Try again in a second" }).lookup)).toContain("#claim=tok123");
  });

  test("says why a site can't be claimed, and never reads its database then", async () => {
    const { lookup: l, queries } = lookup(world, { announced: false, reason: "This site already belongs to an org" });
    await expect(claimLinkFor("https://blog-site.agency.workers.dev", l)).rejects.toThrow("already belongs to an org");
    expect(queries).toEqual([]);
  });

  test("a site deployed before claim links is told to redeploy", async () => {
    await expect(claimLinkFor("https://blog-site.agency.workers.dev", lookup(world, 404).lookup)).rejects.toThrow("redeploy");
  });

  test("no claim row in the database it found is an error that names the Worker", async () => {
    const l = lookup({ ...world, claims: {} }).lookup;
    await expect(claimLinkFor("https://blog-site.agency.workers.dev", l)).rejects.toThrow("blog-site's database has no claim link");
  });
});

describe("vibe-cms admin attach with just an address", () => {
  const world: World = { subdomain: "agency", bindings: { "blog-site": [d1("DB", "db-1")] }, claims: { "db-1": "tok123" } };

  test("fetches the link, then attaches with it", async () => {
    const sent: unknown[] = [];
    async function post(_path: string, body: unknown) {
      sent.push(body);
      return Response.json({ id: "s", name: "Blog", url: "https://blog-site.agency.workers.dev" }, { status: 201 });
    }
    const site = await attach({ link: "https://blog-site.agency.workers.dev" }, post as never, async () => lookup(world).lookup);
    expect(site.name).toBe("Blog");
    expect(sent).toEqual([{ link: "https://blog-site.agency.workers.dev/_vibe/admin/#claim=tok123" }]);
  });

  test("a link that already has its claim goes straight to the panel, with no Cloudflare lookup", async () => {
    const sent: unknown[] = [];
    async function post(_path: string, body: unknown) {
      sent.push(body);
      return Response.json({ id: "s", name: "Blog", url: "https://x.test" }, { status: 201 });
    }
    await attach({ link: "https://x.test/_vibe/admin/#claim=abc" }, post as never, async () => {
      throw new Error("shouldn't look anything up");
    });
    expect(sent).toEqual([{ link: "https://x.test/_vibe/admin/#claim=abc" }]);
  });
});

describe("against a real site", () => {
  const db = createD1();
  const vibe = createHandler(config, { dev: false, bindings: (e: { DB: typeof db }) => ({ db: e.DB }) });
  const worker = vibe({ fetch: async () => new Response("home") });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => worker.fetch(request, { DB: db }, { waitUntil() {}, passThroughOnException() {} } as never) });
  afterAll(() => server.stop(true));

  test("the link it reads from the database is one the site then accepts, once", async () => {
    const host = `127.0.0.1:${server.port}`;
    const real: ClaimLookup = {
      accounts,
      api: {
        workers: async () => [],
        subdomain: async () => null,
        // The site's own database, read the way Cloudflare's API would.
        allDomains: async () => [{ hostname: "127.0.0.1", worker: "site" }],
        bindings: async () => [d1("DB", "local-db")],
        d1Query: async (_a: string, _d: string, sql: string, params: unknown[] = []) => db.sqlite.query(sql).all(...params as never[]) as Array<Record<string, unknown>>
      } as ClaimLookup["api"]
    };
    const link = await claimLinkFor(`http://${host}`, real);
    const token = link.split("#claim=")[1]!;
    expect(link).toBe(`http://${host}/_vibe/admin/#claim=${token}`);
    expect(token.length).toBeGreaterThan(20);
    // Asking again gives the same token, until it's used.
    await Bun.sleep(1100);
    expect(await claimLinkFor(`http://${host}`, real)).toBe(link);
  });
});
