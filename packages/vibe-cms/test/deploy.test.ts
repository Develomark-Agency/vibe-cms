import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CloudflareApi, findPanels, type Binding, type Exec } from "../src/cli/deploy/cloudflare.ts";
import { checkProvider, providerOf } from "../src/cli/deploy/oidc-check.ts";
import { Cancelled, type Prompts } from "../src/cli/deploy/prompts.ts";
import { configRoot, listHubs, readHub, renderWrangler, writeHub, type Bundle, type HubRecord } from "../src/cli/deploy/state.ts";
import type { OidcCheck } from "../src/cli/deploy/oidc-check.ts";
import { runWizard } from "../src/cli/deploy/wizard.ts";

const bundle: Bundle = {
  dir: "/pkg/panel-dist",
  manifest: { compatibility_date: "2026-10-01", compatibility_flags: [], run_worker_first: ["/api/*"], crons: ["*/5 * * * *"] }
};

const record: HubRecord = {
  version: 1,
  accountId: "acc1",
  name: "vibe-panel",
  database: { name: "vibe-panel", id: "11111111-1111-1111-1111-111111111111" },
  backups: "vibe-panel-backups",
  vars: { VIBE_ORG: "agency.test", OIDC_ISSUER: "https://idp.test", OIDC_CLIENT_ID: "client", PANEL_ALLOW: "agency.test" },
  domain: null
};

/** A provider that checks out, so the wizard doesn't reach for the network. */
async function fineProvider(issuer: string): Promise<OidcCheck> {
  return { issuer: issuer.replace(/\/+$/, ""), provider: null, errors: [], warnings: [], notes: [], asksAboutEmail: false };
}

/** Answers the wizard's questions in order, each matched by a pattern in the question, and records what was said. */
function script(answers: Array<[RegExp, unknown]>) {
  const log: string[] = [];
  const queue = [...answers];
  function answer(message: string) {
    const at = queue.findIndex(([pattern]) => pattern.test(message));
    if(at < 0) throw new Error(`Unexpected question: ${message}`);
    return queue.splice(at, 1)[0]![1];
  }
  const prompts: Prompts = {
    intro: m => void log.push(m),
    outro: m => void log.push(m),
    note: (body, title) => void log.push(`${title ?? ""}\n${body}`),
    info: m => void log.push(m),
    warn: m => void log.push(`warn: ${m}`),
    success: m => void log.push(m),
    text: async o => answer(o.message) as string,
    password: async o => answer(o.message) as string,
    confirm: async o => answer(o.message) as boolean,
    select: async o => answer(o.message) as never,
    spinner: () => ({ start: m => void log.push(m), stop: m => void log.push(m) })
  };
  return { prompts, log, left: () => queue.map(([p]) => String(p)) };
}

interface Call {
  args: string[],
  secrets?: Record<string, string>
}

function fakeWrangler(options: { loggedIn?: boolean } = {}) {
  const calls: Call[] = [];
  async function exec(args: string[]) {
    const call: Call = { args };
    const file = args[args.indexOf("--secrets-file") + 1];
    if(args.includes("--secrets-file") && file) call.secrets = JSON.parse(await readFile(file, "utf8"));
    calls.push(call);
    if(args[0] === "whoami") return { code: 0, stdout: options.loggedIn === false ? JSON.stringify({ loggedIn: false }) : JSON.stringify({ loggedIn: true, email: "me@agency.test", accounts: [{ id: "acc1", name: "Agency" }] }), stderr: "" };
    if(args[0] === "d1") return { code: 0, stdout: "database_id = \"22222222-2222-2222-2222-222222222222\"", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
  return { exec: exec as Exec, calls };
}

function fakeApi(overrides: Partial<Record<keyof CloudflareApi, unknown>> = {}) {
  const txt: Array<{ name: string, content: string }> = [];
  const api = {
    databases: async () => [],
    buckets: async () => [],
    workers: async () => [],
    bindings: async () => [],
    domains: async () => [],
    subdomain: async () => "agency",
    zoneFor: async (_: string, host: string) => host.endsWith("agency.test") ? { id: "zone1", name: "agency.test" } : null,
    txtRecords: async () => [],
    createTxt: async (_zone: string, name: string, content: string) => void txt.push({ name, content }),
    ...overrides
  } as unknown as CloudflareApi;
  return { api, txt };
}

async function tmpRoot() {
  return path.join(await mkdtemp(path.join(tmpdir(), "vibe-hubs-")), "panels");
}

describe("hub state", () => {
  test("renders a Worker config that points at the bundle and marks the panel", () => {
    const config = JSON.parse(renderWrangler({ ...record, domain: "admin.agency.test" }, bundle).replace(/^\/\/.*\n/, ""));
    expect(config.main).toBe("/pkg/panel-dist/index.js");
    // Without this, a panel and a site on workers.dev in one account can't call each other.
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
    expect(config.assets.directory).toBe("/pkg/panel-dist/client");
    expect(config.vars).toMatchObject({ VIBE_PANEL: "1", VIBE_ORG: "agency.test" });
    expect(config.routes).toEqual([{ pattern: "admin.agency.test", custom_domain: true }]);
    expect(config.r2_buckets).toEqual([{ binding: "BACKUPS", bucket_name: "vibe-panel-backups" }]);
    expect(config.d1_databases[0]).toMatchObject({ binding: "DB", database_id: record.database.id });
    const bare = JSON.parse(renderWrangler({ ...record, backups: null }, bundle).replace(/^\/\/.*\n/, ""));
    expect(bare.r2_buckets).toBeUndefined();
    expect(bare.routes).toBeUndefined();
  });

  test("keeps several hubs, across accounts, apart", async () => {
    const root = await tmpRoot();
    await writeHub(root, record, bundle);
    await writeHub(root, { ...record, name: "client-hub", accountId: "acc2" }, bundle);
    await writeHub(root, { ...record, name: "vibe-panel", accountId: "acc2" }, bundle);
    expect((await listHubs(root)).map(h => `${h.accountId}/${h.name}`).toSorted()).toEqual(["acc1/vibe-panel", "acc2/client-hub", "acc2/vibe-panel"]);
    expect((await readHub(root, "acc1", "vibe-panel"))?.accountId).toBe("acc1");
    expect(await listHubs(path.join(root, "nothing-here"))).toEqual([]);
  });

  test("lives under the user's config directory unless told otherwise", () => {
    expect(configRoot({ XDG_CONFIG_HOME: "/x" })).toBe("/x/vibe-cms/panels");
    expect(configRoot({ VIBE_CMS_HOME: "/y" })).toBe("/y/panels");
  });
});

describe("finding panels on Cloudflare", () => {
  test("keeps Workers with the VIBE_PANEL variable and reads their settings back", async () => {
    const bindings: Record<string, Binding[]> = {
      panel: [
        { type: "plain_text", name: "VIBE_PANEL", text: "1" },
        { type: "plain_text", name: "VIBE_ORG", text: "agency.test" },
        { type: "d1", name: "DB", id: "11111111-1111-1111-1111-111111111111" },
        { type: "r2_bucket", name: "BACKUPS", bucket_name: "bk" },
        { type: "secret_text", name: "HUB_SIGNING_KEY" }
      ],
      other: [{ type: "plain_text", name: "VIBE_ORG", text: "not-a-panel" }],
      broken: []
    };
    const { api } = fakeApi({
      workers: async () => ["panel", "other", "broken", "unreadable"],
      databases: async () => [{ id: "11111111-1111-1111-1111-111111111111", name: "my-db" }],
      bindings: async (_: string, name: string) => {
        if(!bindings[name]) throw new Error("denied");
        return bindings[name];
      },
      domains: async () => ["admin.agency.test"]
    });
    const found = await findPanels(api, "acc1");
    expect(found.map(f => f.name)).toEqual(["panel"]);
    expect(found[0]!.secrets).toEqual(["HUB_SIGNING_KEY"]);
    expect(found[0]!.record).toMatchObject({ backups: "bk", domain: "admin.agency.test", vars: { VIBE_ORG: "agency.test" }, database: { name: "my-db" } });
  });
});

describe("admin deploy", () => {
  test("sets up a new panel: asks first, creates what was confirmed, deploys with secrets, shows the setup link", async () => {
    const root = await tmpRoot();
    const wrangler = fakeWrangler();
    const { api, txt } = fakeApi();
    const ui = script([
      [/No panels found/, "new"],
      [/Worker name/, "vibe-panel"],
      [/D1 database name/, "vibe-panel"],
      [/Keep daily backups/, true],
      [/R2 bucket name/, "vibe-panel-backups"],
      [/org's domain/, "agency.test"],
      [/OIDC issuer/, "https://idp.test"],
      [/OIDC client ID/, "client"],
      [/Who may sign in/, "agency.test"],
      [/Serve the panel from your own domain/, true],
      [/Panel hostname/, "admin.agency.test"],
      [/OIDC client secret/, "s3cret"],
      [/deploy now/i, true],
      [/Add the DNS record/, true]
    ]);
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root, api: async () => api, needsOwner: async () => null });

    const commands = wrangler.calls.map(c => c.args.slice(0, 4).join(" "));
    expect(commands.slice(0, 3)).toEqual(["whoami --json", "d1 create vibe-panel", "r2 bucket create vibe-panel-backups"]);
    expect(commands[3]).toMatch(/^deploy /);
    const deployed = wrangler.calls.find(c => c.args[0] === "deploy")!;
    expect(Object.keys(deployed.secrets!).sort()).toEqual(["HUB_SIGNING_KEY", "OIDC_CLIENT_SECRET", "PANEL_SETUP_TOKEN"]);
    expect(deployed.secrets!.OIDC_CLIENT_SECRET).toBe("s3cret");
    expect(JSON.parse(deployed.secrets!.HUB_SIGNING_KEY!)).toMatchObject({ alg: "ES256" });

    const saved = (await readHub(root, "acc1", "vibe-panel"))!;
    expect(saved).toMatchObject({ domain: "admin.agency.test", database: { id: "22222222-2222-2222-2222-222222222222" }, secrets: expect.arrayContaining(["HUB_SIGNING_KEY"]) });
    expect(await readFile(path.join(root, "acc1", "vibe-panel", "wrangler.jsonc"), "utf8")).toContain("\"VIBE_PANEL\": \"1\"");

    const out = ui.log.join("\n");
    expect(out).toContain(`https://admin.agency.test/#setup=${deployed.secrets!.PANEL_SETUP_TOKEN}`);
    expect(out).toContain("https://admin.agency.test/auth/callback");
    expect(txt).toEqual([{ name: "_vibe-hub.agency.test", content: "https://admin.agency.test" }]);
    // The secrets themselves are never printed.
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain(deployed.secrets!.HUB_SIGNING_KEY!);
    expect(ui.left()).toEqual([]);
  });

  test("nothing is created until the whole plan is confirmed, and declining it creates nothing", async () => {
    const wrangler = fakeWrangler();
    const { api } = fakeApi();
    const ui = script([
      [/No panels found/, "new"],
      [/Worker name/, "vibe-panel"],
      [/D1 database name/, "vibe-panel"],
      [/Keep daily backups/, true],
      [/R2 bucket name/, "vibe-panel-backups"],
      [/org's domain/, "agency.test"],
      [/OIDC issuer/, "https://idp.test"],
      [/OIDC client ID/, "client"],
      [/Who may sign in/, "agency.test"],
      [/Serve the panel from your own domain/, false],
      [/OIDC client secret/, "s3cret"],
      [/Create these and deploy now/, false]
    ]);
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root: await tmpRoot(), api: async () => api, needsOwner: async () => null });
    expect(wrangler.calls.map(c => c.args[0])).toEqual(["whoami"]);
    const out = ui.log.join("\n");
    expect(out).toContain("$ wrangler d1 create vibe-panel");
    expect(out).toContain("$ wrangler r2 bucket create vibe-panel-backups");
    expect(ui.log.at(-1)).toContain("Nothing");
  });

  test("a redeploy keeps the secrets it has and asks for no setup link when the panel is claimed", async () => {
    const root = await tmpRoot();
    await writeHub(root, { ...record, secrets: ["OIDC_CLIENT_SECRET", "HUB_SIGNING_KEY"] }, bundle);
    const wrangler = fakeWrangler();
    const { api } = fakeApi({ bindings: async () => [{ type: "secret_text", name: "OIDC_CLIENT_SECRET" }, { type: "secret_text", name: "HUB_SIGNING_KEY" }] satisfies Binding[] });
    const ui = script([
      [/Which panel/, "hub:acc1:vibe-panel"],
      [/what next/, "redeploy"],
      [/deploy now/i, true],
      [/Add the DNS record/, false]
    ]);
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root, api: async () => api, needsOwner: async () => false });
    const deployed = wrangler.calls.find(c => c.args[0] === "deploy")!;
    expect(deployed.args).not.toContain("--secrets-file");
    expect(ui.log.join("\n")).not.toContain("#setup=");
    expect(ui.left()).toEqual([]);
  });

  test("replacing the signing key sends just the new key", async () => {
    const root = await tmpRoot();
    await writeHub(root, { ...record, secrets: ["OIDC_CLIENT_SECRET", "HUB_SIGNING_KEY"] }, bundle);
    const wrangler = fakeWrangler();
    const { api } = fakeApi();
    const ui = script([
      [/Which panel/, "hub:acc1:vibe-panel"],
      [/what next/, "key"],
      [/deploy now/i, true],
      [/Add the DNS record/, false]
    ]);
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root, api: async () => api, needsOwner: async () => false });
    expect(Object.keys(wrangler.calls.find(c => c.args[0] === "deploy")!.secrets!)).toEqual(["HUB_SIGNING_KEY"]);
  });

  test("brings a panel found on Cloudflare back, and leaves its secrets alone", async () => {
    const root = await tmpRoot();
    const wrangler = fakeWrangler();
    const { api } = fakeApi({
      workers: async () => ["found-panel"],
      bindings: async () => [
        { type: "plain_text", name: "VIBE_PANEL", text: "1" },
        { type: "plain_text", name: "VIBE_ORG", text: "agency.test" },
        { type: "plain_text", name: "OIDC_ISSUER", text: "https://idp.test" },
        { type: "plain_text", name: "OIDC_CLIENT_ID", text: "client" },
        { type: "plain_text", name: "PANEL_ALLOW", text: "agency.test" },
        { type: "d1", name: "DB", id: "11111111-1111-1111-1111-111111111111" },
        { type: "secret_text", name: "OIDC_CLIENT_SECRET" },
        { type: "secret_text", name: "HUB_SIGNING_KEY" }
      ] satisfies Binding[]
    });
    const ui = script([
      [/No panels found/, "search"],
      [/Which one/, "found-panel"],
      [/what next/, "redeploy"],
      [/deploy now/i, true],
      [/Add the DNS record/, false]
    ]);
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root, api: async () => api, needsOwner: async () => false });
    expect((await readHub(root, "acc1", "found-panel"))?.vars.VIBE_ORG).toBe("agency.test");
    expect(wrangler.calls.find(c => c.args[0] === "deploy")!.args).not.toContain("--secrets-file");
  });

  test("the whole setup works without a custom domain, on the workers.dev address", async () => {
    const root = await tmpRoot();
    const wrangler = fakeWrangler();
    const { api, txt } = fakeApi();
    const ui = script([
      [/No panels found/, "new"],
      [/Worker name/, "vibe-panel"],
      [/D1 database name/, "vibe-panel"],
      [/Keep daily backups/, false],
      [/org's domain/, "agency.test"],
      [/OIDC issuer/, "https://idp.test"],
      [/OIDC client ID/, "client"],
      [/Who may sign in/, "agency.test"],
      [/Serve the panel from your own domain/, false],
      [/OIDC client secret/, "s3cret"],
      [/deploy now/i, true],
      [/Add the DNS record/, true]
    ]);
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root, api: async () => api, needsOwner: async () => null });
    const saved = (await readHub(root, "acc1", "vibe-panel"))!;
    expect(saved.domain).toBeNull();
    expect(saved.url).toBe("https://vibe-panel.agency.workers.dev");
    expect(JSON.parse((await readFile(path.join(root, "acc1", "vibe-panel", "wrangler.jsonc"), "utf8")).replace(/^\/\/.*\n/, "")).routes).toBeUndefined();
    expect(ui.log.join("\n")).toContain("https://vibe-panel.agency.workers.dev/#setup=");
    expect(txt).toEqual([{ name: "_vibe-hub.agency.test", content: "https://vibe-panel.agency.workers.dev" }]);
    expect(ui.left()).toEqual([]);
  });

  test("an org domain isn't required: the panel's own address is the org, and no DNS record is offered", async () => {
    const root = await tmpRoot();
    const wrangler = fakeWrangler();
    const { api, txt } = fakeApi();
    const ui = script([
      [/No panels found/, "new"],
      [/Worker name/, "vibe-panel"],
      [/D1 database name/, "vibe-panel"],
      [/Keep daily backups/, false],
      [/org's domain/, ""],
      [/OIDC issuer/, "https://idp.test"],
      [/OIDC client ID/, "client"],
      [/Who may sign in/, "agency.test"],
      [/Serve the panel from your own domain/, false],
      [/OIDC client secret/, "s3cret"],
      [/deploy now/i, true]
    ]);
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root, api: async () => api, needsOwner: async () => null });
    const saved = (await readHub(root, "acc1", "vibe-panel"))!;
    expect(saved.vars.VIBE_ORG).toBe("https://vibe-panel.agency.workers.dev");
    expect(txt).toEqual([]);
    expect(ui.log.join("\n")).toContain("no DNS record is needed");
    expect(ui.left()).toEqual([]);
  });

  test("an unreachable domain deploys to workers.dev and says what to do", async () => {
    const root = await tmpRoot();
    const wrangler = fakeWrangler();
    const { api } = fakeApi({ zoneFor: async () => null });
    const ui = script([
      [/No panels found/, "new"],
      [/Worker name/, "p"],
      [/D1 database name/, "p"],
      [/Keep daily backups/, false],
      [/org's domain/, "elsewhere.test"],
      [/OIDC issuer/, "https://idp.test"],
      [/OIDC client ID/, "c"],
      [/Who may sign in/, "elsewhere.test"],
      [/Serve the panel from your own domain/, true],
      [/Panel hostname/, "admin.elsewhere.test"],
      [/Deploy to workers.dev for now/, true],
      [/OIDC client secret/, "x"],
      [/deploy now/i, true]
    ]);
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root, api: async () => api, needsOwner: async () => null });
    const saved = (await readHub(root, "acc1", "p"))!;
    expect(saved.domain).toBeNull();
    expect(saved.url).toBe("https://p.agency.workers.dev");
    expect(ui.log.join("\n")).toContain("_vibe-hub.elsewhere.test   TXT   \"https://p.agency.workers.dev\"");
  });

  test("an existing DNS record for the org is never overwritten", async () => {
    const root = await tmpRoot();
    await writeHub(root, { ...record, secrets: ["OIDC_CLIENT_SECRET", "HUB_SIGNING_KEY"] }, bundle);
    const wrangler = fakeWrangler();
    const { api, txt } = fakeApi({ txtRecords: async () => [{ id: "r", content: "https://old-hub.test" }] });
    const ui = script([[/Which panel/, "hub:acc1:vibe-panel"], [/what next/, "redeploy"], [/deploy now/i, true]]);
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root, api: async () => api, needsOwner: async () => false });
    expect(txt).toEqual([]);
    expect(ui.log.join("\n")).toContain("already exists");
  });

  test("offers to log in when wrangler isn't, and stops if declined", async () => {
    const wrangler = fakeWrangler({ loggedIn: false });
    const ui = script([[/wrangler login/, false]]);
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root: await tmpRoot(), api: async () => null });
    expect(wrangler.calls.map(c => c.args[0])).toEqual(["whoami"]);
  });

  test("a cancelled prompt ends quietly", async () => {
    const wrangler = fakeWrangler();
    const ui = script([]);
    ui.prompts.select = async () => { throw new Cancelled(); };
    await runWizard({ checkOidc: fineProvider, exec: wrangler.exec, prompts: ui.prompts, bundle, root: await tmpRoot(), api: async () => null });
    expect(ui.log.at(-1)).toContain("Cancelled");
  });
});

function discovery(doc: Record<string, unknown>, status = 200): typeof fetch {
  const base = { issuer: "https://idp.test", authorization_endpoint: "https://idp.test/a", token_endpoint: "https://idp.test/t", jwks_uri: "https://idp.test/j" };
  return (async () => Response.json({ ...base, ...doc }, { status })) as unknown as typeof fetch;
}

describe("checking an identity provider before deploying", () => {
  test("Clerk: offline_access offered, and email_verified isn't listed, so the wizard will ask", async () => {
    const check = await checkProvider("https://well-hagfish-71.clerk.accounts.dev/", discovery({
      scopes_supported: ["openid", "profile", "email", "offline_access"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
      code_challenge_methods_supported: ["S256"],
      claims_supported: ["sub", "iss", "aud", "email", "name"]
    }));
    expect(check).toMatchObject({ issuer: "https://well-hagfish-71.clerk.accounts.dev", provider: "clerk", errors: [], warnings: [], asksAboutEmail: true });
    expect(check.notes.join(" ")).toContain("refresh tokens");
  });

  test("Cloudflare Access: no offline_access gets a warning, and the discovery URL is accepted as the issuer", async () => {
    const check = await checkProvider("https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc/.well-known/openid-configuration", discovery({ scopes_supported: ["openid", "email", "profile", "groups"] }));
    expect(check.issuer).toBe("https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc");
    expect(check.provider).toBe("access");
    expect(check.errors).toEqual([]);
    expect(check.warnings.join(" ")).toContain("offline_access");
  });

  test("a provider that lists email_verified isn't asked about", async () => {
    const check = await checkProvider("https://idp.test", discovery({ scopes_supported: ["openid", "offline_access"], claims_supported: ["sub", "email", "email_verified"] }));
    expect(check.asksAboutEmail).toBe(false);
  });

  test("says why a provider can't work", async () => {
    expect((await checkProvider("https://idp.test", discovery({}, 404))).errors.join(" ")).toContain("404");
    expect((await checkProvider("https://idp.test", discovery({ code_challenge_methods_supported: ["plain"] }))).errors.join(" ")).toContain("PKCE");
    expect((await checkProvider("https://idp.test", discovery({ token_endpoint_auth_methods_supported: ["private_key_jwt"] }))).errors.join(" ")).toContain("private_key_jwt");
    expect((await checkProvider("https://idp.test", discovery({ token_endpoint: undefined }))).errors.join(" ")).toContain("token_endpoint");
    const unreachable = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
    expect((await checkProvider("https://nope.test", unreachable)).errors.join(" ")).toContain("ENOTFOUND");
  });

  test("recognizes the providers it has advice for", () => {
    expect(providerOf("https://team.cloudflareaccess.com/x")).toBe("access");
    expect(providerOf("https://clerk.agency.com")).toBe("clerk");
    expect(providerOf("https://accounts.google.com")).toBe("google");
    expect(providerOf("https://login.example.com")).toBeNull();
  });
});

describe("identity provider questions in the wizard", () => {
  async function clerk(): Promise<OidcCheck> {
    return { issuer: "https://x.clerk.accounts.dev", provider: "clerk", errors: [], warnings: [], notes: [], asksAboutEmail: true };
  }

  function setup(extra: Array<[RegExp, unknown]>) {
    return script([
      [/No panels found/, "new"],
      [/Worker name/, "vibe-panel"],
      [/D1 database name/, "vibe-panel"],
      [/Keep daily backups/, false],
      [/org's domain/, ""],
      ...extra,
      [/Serve the panel from your own domain/, false],
      [/OIDC client secret/, "s3cret"],
      [/deploy now/i, true]
    ]);
  }

  test("Clerk: trusting its emails is asked, saved, and who may sign in can be left empty", async () => {
    const root = await tmpRoot();
    const ui = setup([
      [/OIDC issuer/, "https://x.clerk.accounts.dev"],
      [/OIDC client ID/, "client"],
      [/Who may sign in/, ""],
      [/Trust the emails/, true]
    ]);
    await runWizard({ checkOidc: clerk, exec: fakeWrangler().exec, prompts: ui.prompts, bundle, root, api: async () => fakeApi().api, needsOwner: async () => null });
    const saved = (await readHub(root, "acc1", "vibe-panel"))!;
    expect(saved.vars).toMatchObject({ OIDC_ISSUER: "https://x.clerk.accounts.dev", OIDC_TRUST_EMAIL: "1" });
    expect(saved.vars.PANEL_ALLOW).toBeUndefined();
    expect(ui.log.join("\n")).toContain("offline_access");
    expect(ui.left()).toEqual([]);
  });

  test("a provider that can't work is explained, and the issuer is asked again", async () => {
    const calls: string[] = [];
    async function checks(issuer: string): Promise<OidcCheck> {
      calls.push(issuer);
      return issuer.includes("typo")
        ? { issuer, provider: null, errors: ["answered 404"], warnings: [], notes: [], asksAboutEmail: false }
        : fineProvider(issuer);
    }
    const ui = script([
      [/No panels found/, "new"],
      [/Worker name/, "vibe-panel"],
      [/D1 database name/, "vibe-panel"],
      [/Keep daily backups/, false],
      [/org's domain/, ""],
      [/OIDC issuer/, "https://typo.test"],
      [/Use it anyway/, false],
      [/OIDC issuer/, "https://idp.test"],
      [/OIDC client ID/, "client"],
      [/Who may sign in/, "agency.test"],
      [/Serve the panel from your own domain/, false],
      [/OIDC client secret/, "s3cret"],
      [/deploy now/i, true]
    ]);
    await runWizard({ checkOidc: checks, exec: fakeWrangler().exec, prompts: ui.prompts, bundle, root: await tmpRoot(), api: async () => fakeApi().api, needsOwner: async () => null });
    expect(calls).toEqual(["https://typo.test", "https://idp.test"]);
    expect(ui.log.join("\n")).toContain("warn: answered 404");
    expect(ui.left()).toEqual([]);
  });

  test("changing an existing panel's issuer is confirmed first, because identities are tied to it", async () => {
    const root = await tmpRoot();
    await writeHub(root, { ...record, secrets: ["OIDC_CLIENT_SECRET", "HUB_SIGNING_KEY"] }, bundle);
    const ui = script([
      [/Which panel/, "hub:acc1:vibe-panel"],
      [/what next/, "settings"],
      [/Backups go to/, false],
      [/org's domain/, "agency.test"],
      [/OIDC issuer/, "https://new-idp.test"],
      [/Change the issuer anyway/, true],
      [/OIDC client ID/, "client"],
      [/Who may sign in/, "agency.test"],
      [/Keep serving|Serve the panel from your own domain/, false],
      [/deploy now/i, true],
      [/Add the DNS record/, false]
    ]);
    await runWizard({ checkOidc: fineProvider, exec: fakeWrangler().exec, prompts: ui.prompts, bundle, root, api: async () => fakeApi().api, needsOwner: async () => false });
    expect(ui.log.join("\n")).toContain("new identity");
    expect((await readHub(root, "acc1", "vibe-panel"))!.vars.OIDC_ISSUER).toBe("https://new-idp.test");
    expect(ui.left()).toEqual([]);
  });
});
