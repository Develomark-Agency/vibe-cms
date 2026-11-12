import { beforeEach, describe, expect, test } from "bun:test";
import { activityFromRequest, userAgentFamily } from "../src/handler/activity.ts";
import { issueSession } from "../src/handler/auth.ts";
import { createHandler } from "../src/handler/index.ts";
import { config, roles } from "./fixture.ts";
import { createD1, createR2 } from "./helpers.ts";

/** Writes are awaited here, so a test can read them straight after the request. */
const pending: Array<Promise<unknown>> = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => {})), passThroughOnException() {} };

function setup() {
  const env = { DB: createD1({ roles: { ...roles, auditor: { "*": ["read"], viewActivity: true } } }), MEDIA: createR2() };
  const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA }) });
  async function api(path: string, init: RequestInit & { json?: unknown, token?: string } = {}) {
    const headers = new Headers(init.headers);
    if(init.token) headers.set("authorization", `Bearer ${init.token}`);
    if(init.json !== undefined) headers.set("content-type", "application/json");
    const response = await vibe.handle(new Request(`https://site.test/_vibe${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }), env, ctx as never);
    const body = await response.json() as any;
    await Promise.all(pending.splice(0));
    return { status: response.status, body };
  }
  async function token(session: { sub: string, roles: string[], name?: string }) {
    if(session.sub === "dev") return (await api("/api/session", { method: "POST", json: { dev: true } })).body.token as string;
    await api("/api/info");
    const siteId = (env.DB.sqlite.query("SELECT value FROM vibe_meta WHERE key = 'site_id'").get() as { value: string }).value;
    return (await issueSession(env.DB, session, siteId, "https://site.test")).token;
  }
  return { env, api, token };
}

let t: ReturnType<typeof setup>;
let dev: string;

beforeEach(async () => {
  t = setup();
  dev = await t.token({ sub: "dev", roles: ["dev"] });
});

async function list(token: string, query = "") {
  return t.api(`/api/activity${query}`, { token });
}

describe("activity log", () => {
  test("records writes with the actor, channel, target and changed fields, but not reads", async () => {
    const created = await t.api("/api/documents/author", { method: "POST", token: dev, json: { data: { name: "Ada" } }, headers: { "x-vibe-via": "ui" } });
    const id = created.body.id as string;
    await t.api(`/api/documents/author/${id}`, { method: "PUT", token: dev, json: { data: { name: "Ada L." } }, headers: { "x-vibe-via": "cli", "x-vibe-client": "vibe-cms/9.9.9" } });
    await t.api(`/api/documents/author/${id}/publish`, { method: "POST", token: dev, json: {} });
    await t.api(`/api/documents/author/${id}`, { token: dev });

    const { body } = await list(dev);
    expect(body.entries.map((e: any) => [e.action, e.via])).toEqual([
      ["documents.publish", "rest"],
      ["documents.update", "cli"],
      ["documents.create", "ui"]
    ]);
    const [publish, update, create] = body.entries;
    expect(create).toMatchObject({ actor: "dev", targetType: "author", targetId: id, locale: "en", ok: true });
    expect(create.summary.fields).toEqual(["name"]);
    // Named as it was at the time.
    expect(create.targetLabel).toBe("Ada");
    expect(publish.targetLabel).toBe("Ada L.");
    expect(update.client).toBe("vibe-cms/9.9.9");
    expect(publish.summary.ver).toBe(1);
  });

  test("records refused permission checks, and no data from the request", async () => {
    const editor = await t.token({ sub: "ed", roles: ["editor"], name: "Ed" });
    const refused = await t.api("/api/documents/author", { method: "POST", token: editor, json: { data: { name: "Secret name" } } });
    expect(refused.status).toBe(403);
    const { body } = await list(dev, "?ok=false");
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ actor: "ed", actorName: "Ed", action: "documents.create", ok: false, error: "FORBIDDEN" });
    expect(JSON.stringify(body.entries[0])).not.toContain("Secret name");
  });

  test("people without viewActivity see only their own; with it, everyone's", async () => {
    const editor = await t.token({ sub: "ed", roles: ["editor"] });
    const auditor = await t.token({ sub: "au", roles: ["auditor"] });
    await t.api("/api/documents/post", { method: "POST", token: dev, json: { data: { title: "By dev" } } });
    await t.api("/api/documents/post", { method: "POST", token: editor, json: { data: { title: "By ed" } } });

    expect((await list(editor)).body.entries.map((e: any) => e.actor)).toEqual(["ed"]);
    expect((await list(editor, "?actor=dev")).status).toBe(403);
    // The editor's refused look at someone else's activity is itself recorded.
    expect((await list(auditor)).body.entries.map((e: any) => [e.actor, e.action, e.ok])).toEqual([["ed", "activity.list", false], ["ed", "documents.create", true], ["dev", "documents.create", true]]);
    expect((await list(auditor, "?actor=dev")).body.entries.map((e: any) => e.actor)).toEqual(["dev"]);
  });

  test("pages and filters by action group and target", async () => {
    for(const name of ["A", "B", "C"]) await t.api("/api/documents/author", { method: "POST", token: dev, json: { data: { name } } });
    await t.api("/api/folders", { method: "POST", token: dev, json: { path: "pics" } });
    const first = await list(dev, "?action=documents&limit=2");
    expect(first.body.entries).toHaveLength(2);
    const second = await list(dev, `?action=documents&limit=2&cursor=${first.body.next}`);
    expect(second.body.entries).toHaveLength(1);
    expect(second.body.next).toBeNull();
    const folders = await list(dev, "?action=folders");
    expect(folders.body.entries).toMatchObject([{ action: "folders.create", targetType: "folders", targetId: "pics" }]);
  });

  test("MCP calls are recorded as mcp", async () => {
    await t.api("/api/mcp", {
      method: "POST",
      token: dev,
      headers: { accept: "application/json, text/event-stream", "user-agent": "claude-code/2.1.0 (cli)" },
      json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "documents_create", arguments: { type: "author", data: { name: "Agent" } } } }
    });
    const { body } = await list(dev);
    expect(body.entries[0]).toMatchObject({ action: "documents.create", via: "mcp", client: "claude-code/2.1.0" });
  });

  test("role changes go through the activity log too", async () => {
    await t.api("/api/roles/reviewer", { method: "PUT", token: dev, json: { rules: { "*": ["read"] } } });
    const { body } = await list(dev, "?action=roles");
    expect(body.entries).toMatchObject([{ action: "roles.save", targetId: "reviewer", ok: true }]);
  });
});

describe("channels", () => {
  test("only claimable channels come from the header", () => {
    function request(via: string) {
      return new Request("https://x.test", { headers: { "x-vibe-via": via } });
    }
    expect(activityFromRequest(request("ui")).via).toBe("ui");
    expect(activityFromRequest(request("cron")).via).toBe("rest");
    expect(activityFromRequest(request("hub")).via).toBe("rest");
  });

  test("user agents become a family, not the whole string", () => {
    expect(userAgentFamily("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36")).toBe("Chrome");
    expect(userAgentFamily("claude-code/2.1.0 (external, cli)")).toBe("claude-code/2.1.0");
    expect(userAgentFamily(null)).toBeUndefined();
  });
});

describe("activity labels", () => {
  test("every action that gets logged has a name people can read", async () => {
    const { LABELS, ATTEMPTS } = await import("../src/admin/app/activity-labels.ts");
    const { coreActions } = await import("../src/actions/core.ts");
    const { listActions } = await import("../src/actions/define.ts");
    const logged = listActions(coreActions).filter(a => !a.annotations.readOnly || a.annotations.audit === "read").map(a => a.name);
    expect(logged.filter(name => !LABELS[name])).toEqual([]);
    // A refused attempt at anything that changes something reads as an attempt, not as a thing that happened.
    expect(logged.filter(name => !ATTEMPTS[name])).toEqual([]);
  });
});
