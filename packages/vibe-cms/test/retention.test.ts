import { beforeEach, describe, expect, test } from "bun:test";
import { can, issueSession, permissionSummary } from "../src/handler/auth.ts";
import { createHandler } from "../src/handler/index.ts";
import { beyondReach, ruleIssues } from "../src/roles.ts";
import { config, roles } from "./fixture.ts";
import { createD1, createR2, ctx } from "./helpers.ts";

const siteRoles = {
  ...roles,
  webmaster: { siteSettings: true },
  trashKeeper: { manageTrash: true },
  activityKeeper: { manageActivity: true },
  janitor: { manageTrash: true, manageActivity: true },
  backupper: { manageScheduledBackups: true }
} as never;

function setup() {
  const env = { DB: createD1({ roles: siteRoles }), MEDIA: createR2() };
  const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA }) });
  async function api(path: string, init: RequestInit & { json?: unknown, token?: string } = {}) {
    const headers = new Headers(init.headers);
    if(init.token) headers.set("authorization", `Bearer ${init.token}`);
    if(init.json !== undefined) headers.set("content-type", "application/json");
    const response = await vibe.handle(new Request(`https://site.test/_vibe${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }), env, ctx);
    return { status: response.status, body: await response.json() as any };
  }
  async function token(session: { sub: string, roles: string[] }) {
    if(session.sub === "dev") return (await api("/api/session", { method: "POST", json: { dev: true } })).body.token as string;
    await api("/api/info");
    const siteId = (env.DB.sqlite.query("SELECT value FROM vibe_meta WHERE key = 'site_id'").get() as { value: string }).value;
    return (await issueSession(env.DB, session, siteId, "https://site.test")).token;
  }
  return { env, vibe, api, token };
}

let t: ReturnType<typeof setup>;
let dev: string;

beforeEach(async () => {
  t = setup();
  dev = await t.token({ sub: "dev", roles: ["dev"] });
});

describe("trash retention", () => {
  test("defaults to 30 days, is stored on the site, and applies to the list and the cron", async () => {
    expect((await t.api("/api/trash/retention", { token: dev })).body).toEqual({ days: 30 });
    const set = await t.api("/api/trash/retention", { method: "PUT", token: dev, json: { days: 7 } });
    expect(set.body).toEqual({ days: 7 });
    expect((await t.api("/api/trash", { token: dev })).body.days).toBe(7);

    const created = await t.api("/api/documents/author", { method: "POST", token: dev, json: { data: { name: "Ada" } } });
    await t.api(`/api/documents/author/${created.body.id}`, { method: "DELETE", token: dev });
    await t.vibe.scheduled({ cron: "* * * * *", scheduledTime: Date.now() + 6 * 86_400_000 }, t.env, ctx);
    expect((await t.api("/api/trash", { token: dev })).body.items).toHaveLength(1);
    await t.vibe.scheduled({ cron: "* * * * *", scheduledTime: Date.now() + 8 * 86_400_000 }, t.env, ctx);
    expect((await t.api("/api/trash", { token: dev })).body.items).toHaveLength(0);
  });

  test("setting the default again clears the stored value", async () => {
    await t.api("/api/trash/retention", { method: "PUT", token: dev, json: { days: 7 } });
    await t.api("/api/trash/retention", { method: "PUT", token: dev, json: { days: 30 } });
    const stored = t.env.DB.sqlite.query("SELECT value FROM vibe_meta WHERE key = 'site'").get() as { value: string } | null;
    expect(JSON.parse(stored?.value ?? "{}").trashDays).toBeUndefined();
  });

  test("refuses days outside 1 to 3650", async () => {
    for(const days of [0, -1, 1.5, 3651]) expect((await t.api("/api/trash/retention", { method: "PUT", token: dev, json: { days } })).status).toBe(400);
  });

  test("is changed only by roles that have manageTrash; siteSettings doesn't give it", async () => {
    const change = async (name: string) => (await t.api("/api/trash/retention", { method: "PUT", token: await t.token({ sub: name, roles: [name] }), json: { days: 10 } })).status;
    expect(await change("trashKeeper")).toBe(200);
    expect(await change("janitor")).toBe(200);
    expect(await change("webmaster")).toBe(403);
    expect(await change("activityKeeper")).toBe(403);
    expect(await change("editor")).toBe(403);
  });

  test("anyone signed in can read it", async () => {
    const editor = await t.token({ sub: "ed", roles: ["editor"] });
    expect((await t.api("/api/trash/retention", { token: editor })).status).toBe(200);
    expect((await t.api("/api/trash/retention")).status).toBe(401);
  });
});

describe("activity retention", () => {
  test("defaults to 90 days and applies to the cron's pruning", async () => {
    expect((await t.api("/api/activity/retention", { token: dev })).body).toEqual({ days: 90 });
    expect((await t.api("/api/activity/retention", { method: "PUT", token: dev, json: { days: 10 } })).body).toEqual({ days: 10 });

    const old = Date.now() - 20 * 86_400_000;
    t.env.DB.sqlite.query("UPDATE vibe_activity SET at = ?").run(old);
    expect((await t.api("/api/activity?since=0", { token: dev })).body.entries.length).toBeGreaterThan(0);
    await t.vibe.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, t.env, ctx);
    const left = t.env.DB.sqlite.query("SELECT COUNT(*) AS n FROM vibe_activity WHERE at = ?").get(old) as { n: number };
    expect(left.n).toBe(0);
  });

  test("the change is recorded with the new number", async () => {
    await t.api("/api/activity/retention", { method: "PUT", token: dev, json: { days: 45 } });
    const { body } = await t.api("/api/activity", { token: dev });
    expect(body.entries[0]).toMatchObject({ action: "activity.setRetention", ok: true, summary: { days: 45 } });
  });

  test("is changed only by roles that have manageActivity; siteSettings doesn't give it", async () => {
    const change = async (name: string) => (await t.api("/api/activity/retention", { method: "PUT", token: await t.token({ sub: name, roles: [name] }), json: { days: 120 } })).status;
    expect(await change("activityKeeper")).toBe(200);
    expect(await change("janitor")).toBe(200);
    expect(await change("webmaster")).toBe(403);
    expect(await change("trashKeeper")).toBe(403);
    expect(await change("editor")).toBe(403);
  });
});

describe("permissions", () => {
  const access = { config, roles: { map: siteRoles } };
  const as = (name: string) => ({ sub: name, roles: [name] });

  test("the summary tells the editor what to show", () => {
    expect(permissionSummary(access, as("webmaster"))).toMatchObject({ trash: false, activityRetention: false });
    expect(permissionSummary(access, as("trashKeeper"))).toMatchObject({ trash: true, activityRetention: false });
    expect(permissionSummary(access, as("activityKeeper"))).toMatchObject({ trash: false, activityRetention: true });
    expect(permissionSummary(access, as("editor"))).toMatchObject({ trash: false, activityRetention: false });
    expect(can(access, as("janitor"), { action: "write", scope: "trash" })).toBe(true);
  });

  test("role rules accept the new switches and they can't be granted beyond your own", () => {
    const schema = { types: [], locales: [] };
    expect(ruleIssues({ manageTrash: true, manageActivity: false }, schema)).toEqual([]);
    expect(ruleIssues({ manageTrash: "yes" }, schema)).toEqual(["manageTrash must be true or false"]);
    expect(beyondReach({ manageTrash: true }, [roles.editor as never], schema)).toEqual(["changing how long the trash is kept"]);
    expect(beyondReach({ manageActivity: true }, [roles.editor as never], schema)).toEqual(["changing how long activity is kept"]);
    expect(beyondReach({ manageTrash: true, manageActivity: true }, [{ manageTrash: true, manageActivity: true }], schema)).toEqual([]);
    expect(beyondReach({ manageTrash: true }, [{ siteSettings: true }], schema)).toEqual(["changing how long the trash is kept"]);
  });
});

describe("scheduled backups access", () => {
  const set = async (name: string, enabled: boolean) =>
    (await t.api("/api/site/backup-access", { method: "PUT", token: await t.token({ sub: name, roles: [name] }), json: { enabled } })).status;

  test("is off by default, reported on the site, and changed by an owner-level session", async () => {
    expect((await t.api("/api/site", { token: dev })).body.backups).toBe(false);
    expect((await t.api("/api/site/backup-access", { method: "PUT", token: dev, json: { enabled: true } })).body).toEqual({ enabled: true });
    expect((await t.api("/api/site", { token: dev })).body.backups).toBe(true);
    await t.api("/api/site/backup-access", { method: "PUT", token: dev, json: { enabled: false } });
    expect((await t.api("/api/site", { token: dev })).body.backups).toBe(false);
  });

  test("only roles with manageScheduledBackups may change it; siteSettings and the others don't", async () => {
    expect(await set("backupper", true)).toBe(200);
    expect(await set("webmaster", false)).toBe(403);
    expect(await set("janitor", false)).toBe(403);
    expect(await set("editor", false)).toBe(403);
  });

  test("is recorded in the activity log", async () => {
    await t.api("/api/site/backup-access", { method: "PUT", token: dev, json: { enabled: true } });
    const { body } = await t.api("/api/activity", { token: dev });
    expect(body.entries[0]).toMatchObject({ action: "site.setBackupAccess", ok: true, summary: { enabled: true } });
  });

  test("is kept outside the site settings, so a snapshot neither carries nor changes it", async () => {
    await t.api("/api/site/backup-access", { method: "PUT", token: dev, json: { enabled: true } });
    const site = t.env.DB.sqlite.query("SELECT value FROM vibe_meta WHERE key = 'site'").get() as { value: string } | null;
    expect(JSON.parse(site?.value ?? "{}").backups).toBeUndefined();
    expect((t.env.DB.sqlite.query("SELECT value FROM vibe_meta WHERE key = 'backup_access'").get() as { value: string }).value).toBe("1");
  });

  test("the role rule is checked, named and limited like the others", () => {
    const access = { config, roles: { map: siteRoles } };
    expect(permissionSummary(access, { sub: "b", roles: ["backupper"] }).scheduledBackups).toBe(true);
    expect(permissionSummary(access, { sub: "w", roles: ["webmaster"] }).scheduledBackups).toBe(false);
    const schema = { types: [], locales: [] };
    expect(ruleIssues({ manageScheduledBackups: "yes" }, schema)).toEqual(["manageScheduledBackups must be true or false"]);
    expect(beyondReach({ manageScheduledBackups: true }, [{ siteSettings: true, backups: true }], schema)).toEqual(["turning scheduled backups on or off"]);
  });
});
