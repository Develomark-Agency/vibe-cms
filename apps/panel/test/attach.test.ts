import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clearOrgCache } from "vibe-cms/org";
import { parseClaimLink } from "../src/server/sites.ts";
import { createD1 } from "../../../packages/vibe-cms/test/helpers.ts";
import { env, HUB, idp, installMock, ORG, panel, removeMock, signIn, site, sites, txt } from "./mock.ts";

/** Runs `work` while collecting what the site (or panel) logs. */
async function logged<T>(work: () => Promise<T>): Promise<{ result: T, lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    const result = await work();
    // The links are printed from `waitUntil` work, which the mock lets run on its own.
    await new Promise(resolve => setTimeout(resolve, 30));
    return { result, lines };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

let origin: string;
let count = 0;

/** A site deployed without VIBE_ORG, touched once so it logs its claim link. */
async function deployUnclaimed(db = createD1()): Promise<{ origin: string, link: string, lines: string[] }> {
  origin = `https://claim-${++count}.test`;
  sites[origin] = site("", { DB: db });
  // The editor's first call to the site is when a new site prints its links.
  const { lines } = await logged(() => sites[origin]!(new Request(`${origin}/_vibe/api/info`)));
  const link = lines.join("\n").match(/(https:\/\/\S+#claim=\S+)/)?.[1];
  expect(link).toBeTruthy();
  return { origin, link: link!, lines };
}

async function descriptor(at: string) {
  return await (await sites[at]!(new Request(`${at}/.well-known/vibe-cms`))).json() as { id: string, org: string | null };
}

function attach(body: Record<string, unknown>) {
  return panel("/api/sites/attach", { method: "POST", body: JSON.stringify(body) });
}

// A hub of its own, so these sites don't show up in other files' lists.
const shared = env.DB;
beforeAll(() => {
  installMock();
  env.DB = createD1() as unknown as D1Database;
});
afterAll(() => {
  env.DB = shared;
  removeMock();
});
beforeEach(async () => {
  clearOrgCache();
  env.VIBE_ORG = ORG;
  txt["_vibe-hub.agency.test"] = HUB;
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
  await signIn();
});

describe("claim links", () => {
  test("a site without an org logs a claim link, once, and the panel won't add it without one", async () => {
    const first = await deployUnclaimed();
    expect(first.link).toBe(`${first.origin}/_vibe/admin/#claim=${first.link.split("#claim=")[1]}`);
    expect(first.lines.join("\n")).toContain("attach this site to your org's panel");
    expect(await descriptor(first.origin)).toMatchObject({ org: null });
    // Later requests don't repeat it.
    const again = await logged(() => sites[first.origin]!(new Request(`${first.origin}/_vibe/api/info`)));
    expect(again.lines.join("\n")).not.toContain("#claim=");

    const refused = await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: first.origin }) });
    expect(refused.status).toBe(422);
    expect((await refused.json() as { error: string }).error).toContain("claim link");
  });

  test("reads links as logged, and refuses anything else", () => {
    expect(parseClaimLink("https://client.com/_vibe/admin/#claim=abc_-1")).toEqual({ url: "https://client.com", token: "abc_-1" });
    expect(parseClaimLink("  client.com#claim=abc  ")).toEqual({ url: "https://client.com", token: "abc" });
    expect(parseClaimLink("http://localhost:1337/_vibe/admin/#claim=abc")).toEqual({ url: "http://localhost:1337", token: "abc" });
    expect(() => parseClaimLink("https://client.com")).toThrow("claim link");
    expect(() => parseClaimLink("not a link at all %%")).toThrow("claim link");
  });
});

describe("attaching a site", () => {
  test("claims the site for the hub's org, adds it, and the site then signs people in through the hub", async () => {
    const { origin, link } = await deployUnclaimed();
    const before = await descriptor(origin);

    const response = await attach({ link });
    expect(response.status).toBe(201);
    const added = await response.json() as { id: string, url: string };
    expect(added).toMatchObject({ id: before.id, url: origin });
    expect(await descriptor(origin)).toMatchObject({ org: ORG });

    // The hub vouches for Jane, and the site accepts it.
    const code = await (await panel(`/api/sites/${added.id}/code`, { method: "POST" })).json() as { code: string };
    const exchange = await sites[origin]!(new Request(`${origin}/_vibe/api/session`, { method: "POST", body: JSON.stringify({ code: code.code }) }));
    expect(exchange.status).toBe(200);

    // It's in the org's history, with no complaint about a missing VIBE_ORG.
    const { lines } = await logged(() => sites[origin]!(new Request(`${origin}/.well-known/vibe-cms`)));
    expect(lines.join("\n")).not.toContain("VIBE_ORG isn't set");
    expect((await (await panel("/api/sites")).json() as Array<{ id: string }>).map(s => s.id)).toContain(added.id);
  });

  test("the link works once; the claim itself is refused after that, but attaching again just adds", async () => {
    const { origin, link } = await deployUnclaimed();
    expect((await attach({ link })).status).toBe(201);
    const token = link.split("#claim=")[1];
    const replay = await sites[origin]!(new Request(`${origin}/_vibe/api/org/claim`, { method: "POST", body: JSON.stringify({ token, org: ORG }) }));
    expect(replay.status).toBe(409);
    expect((await attach({ link })).status).toBe(201);
  });

  test("a wrong token is refused and leaves the site unclaimed, and the right link still works", async () => {
    const { origin, link } = await deployUnclaimed();
    const wrong = await attach({ link: `${origin}/_vibe/admin/#claim=guess` });
    expect(wrong.status).toBe(401);
    expect((await wrong.json() as { error: string }).error).toContain("claim link");
    expect(await descriptor(origin)).toMatchObject({ org: null });
    expect((await attach({ link })).status).toBe(201);
  });

  test("a missing DNS record is explained, and the same link works once it's added", async () => {
    const { origin, link } = await deployUnclaimed();
    delete txt["_vibe-hub.agency.test"];
    clearOrgCache();
    const refused = await attach({ link });
    expect(refused.status).toBe(422);
    expect((await refused.json() as { error: string }).error).toContain("_vibe-hub");
    expect(await descriptor(origin)).toMatchObject({ org: null });

    txt["_vibe-hub.agency.test"] = HUB;
    clearOrgCache();
    expect((await attach({ link })).status).toBe(201);
  });

  test("a site with its own owners isn't claimed: that's what VIBE_ORG is for", async () => {
    const db = createD1();
    const { origin, link } = await deployUnclaimed(db);
    await db.prepare("INSERT INTO vibe_users (id, email, roles, created_at, created_by) VALUES ('u1', 'owner@client.test', '[\"owner\"]', 0, 'setup')").run();
    const response = await attach({ link });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain("VIBE_ORG");
    expect(await descriptor(origin)).toMatchObject({ org: null });
  });

  test("an org that is the panel's own address works with no DNS record at all", async () => {
    const { origin, link } = await deployUnclaimed();
    env.VIBE_ORG = HUB;
    delete txt["_vibe-hub.agency.test"];
    clearOrgCache();
    const response = await attach({ link });
    expect(response.status).toBe(201);
    const added = await response.json() as { id: string };
    expect(await descriptor(origin)).toMatchObject({ org: HUB });
    const code = await (await panel(`/api/sites/${added.id}/code`, { method: "POST" })).json() as { code: string };
    const exchange = await sites[origin]!(new Request(`${origin}/_vibe/api/session`, { method: "POST", body: JSON.stringify({ code: code.code }) }));
    expect(exchange.status).toBe(200);
  });

  test("Cloudflare's same-account Worker block is explained, whichever way it hits", async () => {
    const blocked = async () => new Response("error code: 1042", { status: 404 });

    // The panel can't call the site.
    sites["https://blocked-site.test"] = blocked;
    const site = await attach({ link: "https://blocked-site.test/_vibe/admin/#claim=abc" });
    expect(site.status).toBe(502);
    expect((await site.json() as { error: string }).error).toContain("global_fetch_strictly_public");

    // The site can't call the panel for its keys.
    const { link } = await deployUnclaimed();
    sites["https://blocked-hub.test"] = blocked;
    env.VIBE_ORG = "https://blocked-hub.test";
    clearOrgCache();
    const hub = await attach({ link });
    expect(hub.status).toBe(422);
    expect((await hub.json() as { error: string }).error).toContain("global_fetch_strictly_public");
  });

  test("a site that already trusts another org isn't claimed", async () => {
    const response = await attach({ link: "https://site-b.test/_vibe/admin/#claim=whatever" });
    expect(response.status).toBe(422);
    expect((await response.json() as { error: string }).error).toContain("other.test");
  });

  test("an address with no claim in it is a bad request", async () => {
    expect((await attach({ link: "https://site-a.test" })).status).toBe(400);
    expect((await attach({})).status).toBe(400);
  });

  test("needs permission to add sites", async () => {
    const { link } = await deployUnclaimed();
    idp.email = "bob@agency.test";
    idp.sub = "u-bob";
    await signIn();
    const response = await attach({ link });
    expect(response.status).toBe(403);
  });
});
