import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { defineConfig } from "vibe-cms";
import { createHandler } from "vibe-cms/handler";
import { clearOrgCache, ORG_MOVE_SCOPE } from "vibe-cms/org";
import v from "vibe-cms/schema";
import { createD1 } from "../../../packages/vibe-cms/test/helpers.ts";
import { env, HUB, hubOrigins, idp, installMock, ORG, panel, removeMock, signIn, sites, txt } from "./mock.ts";

/** A site whose database survives redeploys (new handlers over the same D1), with an admin and an editor. */
function orgSite(origin: string, siteEnv: Record<string, string> = {}) {
  const db = createD1();
  const config = defineConfig({
    permissions: {
      roles: { admin: { all: true }, editor: { post: ["read", "write"] } },
      users: { "jane@agency.test": ["admin"], "bob@agency.test": ["editor"] }
    },
    schemas: { post: v.object({ title: v.text() }) }
  });
  function deploy(vars: Record<string, string>) {
    const vibe = createHandler(config, { dev: false, bindings: (e: { DB: typeof db }) => ({ db: e.DB }) });
    const deployed = { DB: db, VIBE_ORG: ORG, ...vars };
    sites[origin] = request => vibe.handle(request, deployed, { waitUntil() {} });
  }
  deploy(siteEnv);
  return {
    deploy,
    call: (path: string, init?: RequestInit) => sites[origin]!(new Request(`${origin}${path}`, init)),
    async descriptor() {
      return await (await sites[origin]!(new Request(`${origin}/.well-known/vibe-cms`))).json() as { id: string, org: string | null, hub: string | null, orgMove: { to: string, effectiveAt: number } | null };
    }
  };
}

async function add(origin: string): Promise<string> {
  const response = await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: origin }) });
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

/** Signs in on the site through the hub, as the hub's editor does: a code, then a site session. */
async function editorSession(site: ReturnType<typeof orgSite>, id: string): Promise<{ status: number, token?: string }> {
  const handoff = await panel(`/api/sites/${id}/code`, { method: "POST" });
  if(!handoff.ok) return { status: handoff.status };
  const { code } = await handoff.json() as { code: string };
  const exchange = await site.call("/_vibe/api/session", { method: "POST", body: JSON.stringify({ code }) });
  return { status: exchange.status, token: (await exchange.json() as { token?: string }).token };
}

beforeAll(installMock);
beforeEach(() => {
  clearOrgCache();
  env.VIBE_ORG = ORG;
  txt["_vibe-hub.agency.test"] = HUB;
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
});
afterAll(async () => {
  env.VIBE_ORG = ORG;
  txt["_vibe-hub.agency.test"] = HUB;
  delete txt["_vibe-hub.new-agency.test"];
  delete txt["_vibe-hub.thief.test"];
  hubOrigins.delete("https://admin.agency.test");
  hubOrigins.delete("https://thief-hub.test");
  // The panel's database is shared with the other test files: leave it on the original org.
  await env.DB.prepare("DELETE FROM panel_meta WHERE key IN ('org', 'previous_orgs')").run();
  const { results } = await env.DB.prepare("SELECT id FROM sites WHERE url LIKE 'https://org-%'").all<{ id: string }>();
  for(const { id } of results) await panel(`/api/sites/${id}`, { method: "DELETE" });
  for(const origin of Object.keys(sites)) if(origin.startsWith("https://org-")) delete sites[origin];
  clearOrgCache();
  removeMock();
});

describe("orgs", () => {
  test("sites find the hub through the org's DNS record, and follow it when it changes", async () => {
    const site = orgSite("https://org-dns.test");
    await signIn();
    const id = await add("https://org-dns.test");
    expect(await site.descriptor()).toMatchObject({ org: ORG, hub: HUB, orgMove: null });
    expect((await editorSession(site, id)).status).toBe(200);

    // The hub moves to a new address: one DNS record changes, and no site is redeployed.
    hubOrigins.add("https://admin.agency.test");
    txt["_vibe-hub.agency.test"] = "https://admin.agency.test";
    clearOrgCache();
    expect(await site.descriptor()).toMatchObject({ org: ORG, hub: "https://admin.agency.test" });
    expect((await editorSession(site, id)).status).toBe(200);
    expect(await (await panel("/api/org")).json()).toMatchObject({ org: ORG, record: "_vibe-hub.agency.test", hub: "https://admin.agency.test", matches: false });
  });

  test("a site keeps working on its stored keys when its hub can't be reached", async () => {
    const site = orgSite("https://org-offline.test");
    await signIn();
    const id = await add("https://org-offline.test");
    expect((await editorSession(site, id)).status).toBe(200);
    const { userToken } = await import("../src/server/hub.ts");
    const { currentSession } = await import("../src/server/shared.ts");
    const { jar } = await import("./mock.ts");
    const session = await currentSession(new Request(HUB, { headers: { cookie: [...jar].map(([k, val]) => `${k}=${val}`).join("; ") } }), env);
    const token = await userToken(env, session!, id);
    // A redeploy (fresh isolate) while the DNS record is gone: the copy in the database still checks tokens.
    delete txt["_vibe-hub.agency.test"];
    clearOrgCache();
    site.deploy({});
    const me = await site.call("/_vibe/api/session", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
  });

  test("renaming the org moves sites after a delay, and nobody is locked out meanwhile", async () => {
    const site = orgSite("https://org-move.test");
    await signIn();
    const id = await add("https://org-move.test");

    txt["_vibe-hub.new-agency.test"] = HUB;
    env.VIBE_ORG = "new-agency.test";
    const { sites: moved } = await (await panel("/api/org/moves", { method: "POST" })).json() as { sites: Array<{ id: string, state: string, effectiveAt: number }> };
    const status = moved.find(s => s.id === id)!;
    expect(status.state).toBe("requested");
    expect(status.effectiveAt).toBeGreaterThan(Date.now() + 71 * 3600_000);

    const descriptor = await site.descriptor();
    expect(descriptor.org).toBe(ORG);
    expect(descriptor.orgMove).toMatchObject({ to: "new-agency.test" });
    // The hub keeps signing as the old org for this site until it moves.
    expect((await editorSession(site, id)).status).toBe(200);
    // Asking again doesn't restart the clock.
    const again = await (await panel("/api/org/moves", { method: "POST" })).json() as { sites: Array<{ id: string, state: string, effectiveAt: number }> };
    expect(again.sites.find(s => s.id === id)).toMatchObject({ state: "pending", effectiveAt: status.effectiveAt });

    // An editor can't cancel it; someone who can change the site's settings can.
    idp.email = "bob@agency.test";
    idp.sub = "u-bob";
    await signIn();
    const bob = await editorSession(site, id);
    expect((await site.call("/_vibe/api/org/move", { method: "DELETE", headers: { authorization: `Bearer ${bob.token}` } })).status).toBe(403);
    idp.email = "jane@agency.test";
    idp.sub = "u-jane";
    await signIn();
    const jane = await editorSession(site, id);
    const cancelled = await site.call("/_vibe/api/org/move", { method: "DELETE", headers: { authorization: `Bearer ${jane.token}` } });
    expect(await cancelled.json()).toMatchObject({ org: ORG, move: null });
    const history = await (await site.call("/_vibe/api/org", { headers: { authorization: `Bearer ${jane.token}` } })).json() as { history: Array<{ event: string, by?: string }> };
    expect(history.history.map(e => e.event)).toEqual(["set", "move-requested", "move-cancelled"]);
    expect(history.history.at(-1)!.by).toBe("jane@agency.test");
  });

  test("a move takes effect once its delay is up, and the hub signs for the new org", async () => {
    const site = orgSite("https://org-now.test", { VIBE_ORG_MOVE_DELAY: "0" });
    await signIn();
    const id = await add("https://org-now.test");
    txt["_vibe-hub.new-agency.test"] = HUB;
    env.VIBE_ORG = "new-agency.test";
    await panel("/api/org/moves", { method: "POST" });
    expect(await site.descriptor()).toMatchObject({ org: "new-agency.test", orgMove: null });
    // The hub hasn't seen the site move yet: the refused handoff makes it look, then sign for the new org.
    expect((await editorSession(site, id)).status).toBe(200);
    const row = await env.DB.prepare("SELECT org FROM sites WHERE id = ?").bind(id).first<{ org: string }>();
    expect(row!.org).toBe("new-agency.test");

    // Redeploying with the same, now stale, VIBE_ORG keeps the move.
    site.deploy({ VIBE_ORG_MOVE_DELAY: "0" });
    expect((await site.descriptor()).org).toBe("new-agency.test");
    // VIBE_ORG_RESET puts the variable back in charge.
    site.deploy({ VIBE_ORG_RESET: "1" });
    expect((await site.descriptor()).org).toBe(ORG);
    // So does changing the variable.
    site.deploy({ VIBE_ORG: "other.test" });
    expect((await site.descriptor()).org).toBe("other.test");
  });

  test("a site refuses moves its hub didn't sign, and moves to a hub with other keys", async () => {
    const site = orgSite("https://org-forged.test");
    const { id } = await site.descriptor();
    const thief = await generateKeyPair("ES256");
    const forged = await new SignJWT({ scope: ORG_MOVE_SCOPE, to: "thief.test" })
      .setProtectedHeader({ alg: "ES256", kid: "hub-1" })
      .setIssuer(ORG).setAudience(id).setSubject("hub").setIssuedAt().setExpirationTime("5m")
      .sign(thief.privateKey);
    const refused = await site.call("/_vibe/api/org/move", { method: "POST", body: JSON.stringify({ token: forged }) });
    expect(refused.status).toBe(401);

    // Signed by the real hub, but pointing at an org whose hub serves another key: refused too.
    hubOrigins.add("https://thief-hub.test");
    txt["_vibe-hub.thief.test"] = "https://thief-hub.test";
    const otherKey = { ...(await exportJWK((await generateKeyPair("ES256", { extractable: true })).privateKey)), kid: "hub-1" };
    const realKey = env.HUB_SIGNING_KEY;
    const { moveSites } = await import("../src/server/hub.ts");
    await signIn();
    await add("https://org-forged.test");
    env.VIBE_ORG = "thief.test";
    // The thief's hub answers with different keys: swap the hub's key just for its JWKS.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if(url.origin === "https://thief-hub.test") {
        const { d: _d, ...pub } = otherKey;
        return Response.json({ keys: [{ ...pub, alg: "ES256", use: "sig" }] });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const result = await moveSites(env);
      expect(result.sites.find(s => s.id === id)).toMatchObject({ state: "refused", error: "thief.test's hub doesn't serve the key that signed this move" });
    } finally {
      globalThis.fetch = realFetch;
      env.HUB_SIGNING_KEY = realKey;
    }
    expect((await site.descriptor()).orgMove).toBeNull();
  });
});
