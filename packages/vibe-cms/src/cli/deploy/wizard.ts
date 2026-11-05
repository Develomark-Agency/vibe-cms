import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateHubKey } from "../hub.ts";
import { authHeaders, CloudflareApi, findPanels, show, whoami, type Account, type Exec } from "./cloudflare.ts";
import { Cancelled, type Prompts } from "./prompts.ts";
import { configRoot, listHubs, readHub, removeHub, writeHub, type Bundle, type HubRecord } from "./state.ts";

export interface WizardDeps {
  exec: Exec,
  prompts: Prompts,
  bundle: Bundle,
  /** Where hubs are kept on this machine. */
  root?: string,
  /** Reads Cloudflare's API with wrangler's session; null when that isn't possible. Replaceable for tests. */
  api?: (exec: Exec) => Promise<CloudflareApi | null>,
  /** Asks a panel whether it still needs its first owner. Replaceable for tests. */
  needsOwner?: (url: string) => Promise<boolean | null>,
  /** Points wrangler at an account when the person has several. */
  setAccount?: (id: string) => void
}

const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** R2's rule for bucket names; D1 names are looser, so this is a safe shape for both. */
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function required(label: string) {
  return (value: string) => value.trim() ? undefined : `${label} is required`;
}

async function defaultApi(exec: Exec) {
  const headers = await authHeaders(exec);
  return headers ? new CloudflareApi(headers) : null;
}

async function defaultNeedsOwner(url: string) {
  try {
    const response = await fetch(`${url}/api/setup`);
    if(!response.ok) return null;
    return (await response.json() as { needsOwner?: boolean }).needsOwner ?? null;
  } catch {
    return null;
  }
}

/** `vibe-cms admin deploy`: deploys the agency panel to Cloudflare, step by step, asking before each change. */
export async function runWizard(deps: WizardDeps): Promise<void> {
  const { prompts: p } = deps;
  try {
    await wizard(deps);
  } catch (error) {
    if(error instanceof Cancelled) return void p.outro("Cancelled. Nothing more was changed.");
    throw error;
  }
}

async function wizard(deps: WizardDeps) {
  const { exec, prompts: p } = deps;
  const root = deps.root ?? configRoot();
  p.intro("vibe-cms panel");

  // 1. Who wrangler is logged in as, and which account this is for.
  const account = await chooseAccount(deps);
  deps.setAccount?.(account.id);
  const api = await (deps.api ?? defaultApi)(exec);
  if(!api) p.warn("Couldn't read Cloudflare's API with wrangler's login, so existing resources and domains can't be checked. Everything else still works.");

  // 2. Which panel: one found on this machine, a new one, or one found on Cloudflare.
  const hubs = await listHubs(root);
  const choice = await p.select<string>({
    message: hubs.length ? "Which panel?" : "No panels found on this machine. What would you like to do?",
    options: [
      ...hubs.map(h => ({
        value: `hub:${h.accountId}:${h.name}`,
        label: h.name,
        hint: [h.vars.VIBE_ORG, h.domain ?? h.url, h.accountId === account.id ? undefined : "another Cloudflare account"].filter(Boolean).join(" · ")
      })),
      { value: "new", label: "Set up a new panel" },
      { value: "search", label: "Search Cloudflare for an existing panel", hint: `${account.name}` }
    ]
  });

  let record: HubRecord | null = null;
  let secrets: string[] = [];
  if(choice === "new") {
    record = await configure(deps, root, account, api, null);
  } else if(choice === "search") {
    if(!api) throw new Error("Searching needs Cloudflare's API, which wrangler's login couldn't reach. Log in again with `wrangler login`.");
    const found = await searchCloudflare(deps, root, account, api);
    if(!found) return void p.outro("Nothing to do.");
    ({ record, secrets } = found);
  } else {
    const [, accountId, name] = choice.split(":") as [string, string, string];
    record = await readHub(root, accountId, name);
    if(!record) throw new Error(`The saved settings for ${name} can't be read.`);
    if(accountId !== account.id) {
      p.warn(`${name} was set up under another Cloudflare account (${accountId}); wrangler is logged in to ${account.name} (${account.id}).`);
      if(!await p.confirm({ message: "Switch wrangler to that account's login first, then continue?", initial: false })) return void p.outro("Nothing changed.");
    }
    secrets = [...new Set([...record.secrets ?? [], ...api ? await existingSecrets(api, record.accountId, record.name) : []])];
  }
  if(!record) return;

  // 3. What to do with an existing panel.
  if(choice !== "new") {
    const action = await p.select<"redeploy" | "settings" | "key" | "secret" | "forget">({
      message: `${record.name}: what next?`,
      options: [
        { value: "redeploy", label: "Redeploy", hint: "the current panel code, same settings" },
        { value: "settings", label: "Change settings, then redeploy" },
        { value: "key", label: "Replace the signing key", hint: "sites fetch the new key the first time they see it" },
        { value: "secret", label: "Replace the OIDC client secret" },
        { value: "forget", label: "Forget it on this machine", hint: "leaves it running on Cloudflare" }
      ]
    });
    if(action === "forget") {
      await removeHub(root, record.accountId, record.name);
      return void p.outro(`Forgot ${record.name} here. It's still deployed; search Cloudflare to bring it back.`);
    }
    const extra: Secrets = {};
    if(action === "settings") record = await configure(deps, root, account, api, record);
    if(action === "key") extra.HUB_SIGNING_KEY = await generateHubKey();
    if(action === "secret") extra.OIDC_CLIENT_SECRET = await p.password({ message: "New OIDC client secret", validate: required("The client secret") });
    await deploy(deps, root, record, extra, secrets, api);
    return;
  }
  await deploy(deps, root, record, {}, [], api);
}

async function chooseAccount({ exec, prompts: p }: WizardDeps): Promise<Account> {
  let who = await whoami(exec);
  if(!who) {
    p.warn("Wrangler isn't logged in to Cloudflare.");
    if(!await p.confirm({ message: "Run `wrangler login` now?", initial: true })) throw new Cancelled();
    p.info("$ wrangler login");
    if((await exec(["login"], { stream: true })).code) throw new Error("`wrangler login` failed.");
    who = await whoami(exec);
    if(!who) throw new Error("Still not logged in. Run `wrangler login` and try again.");
  }
  if(!who.accounts.length) throw new Error("This login has no Cloudflare accounts.");
  const preset = process.env.CLOUDFLARE_ACCOUNT_ID && who.accounts.find(a => a.id === process.env.CLOUDFLARE_ACCOUNT_ID);
  if(preset) {
    p.info(`Cloudflare account: ${preset.name} (from CLOUDFLARE_ACCOUNT_ID)`);
    return preset;
  }
  if(who.accounts.length === 1) {
    p.info(`Cloudflare account: ${who.accounts[0]!.name}${who.email ? ` (${who.email})` : ""}`);
    return who.accounts[0]!;
  }
  const id = await p.select<string>({ message: "Which Cloudflare account?", options: who.accounts.map(a => ({ value: a.id, label: a.name, hint: a.id })) });
  return who.accounts.find(a => a.id === id)!;
}

async function existingSecrets(api: CloudflareApi, account: string, worker: string) {
  const bindings = await api.bindings(account, worker).catch(() => []);
  return bindings.filter(b => b.type === "secret_text").map(b => b.name);
}

async function searchCloudflare({ prompts: p }: WizardDeps, root: string, account: Account, api: CloudflareApi) {
  const spinner = p.spinner();
  spinner.start("Looking through this account's Workers for panels");
  let panels;
  try {
    panels = await findPanels(api, account.id);
  } catch (error) {
    spinner.stop("Couldn't list Workers");
    throw new Error(`Cloudflare refused the search: ${(error as Error).message}. Wrangler's login may lack permission to read Workers.`);
  }
  spinner.stop(panels.length ? `Found ${panels.length} panel${panels.length === 1 ? "" : "s"}` : "No panels found");
  if(!panels.length) {
    p.note("Panels deployed by this wizard carry a VIBE_PANEL variable, which is how they're found. A panel deployed some other way won't show up; set up a new one, or add `\"vars\": { \"VIBE_PANEL\": \"1\" }` to its config and deploy once.", "Nothing found");
    return null;
  }
  const name = await p.select<string>({
    message: "Which one?",
    options: panels.map(f => ({ value: f.name, label: f.name, hint: [f.record.vars.VIBE_ORG, f.record.domain ?? f.record.url].filter(Boolean).join(" · ") }))
  });
  const found = panels.find(f => f.name === name)!;
  const record: HubRecord = { ...found.record, accountId: account.id, accountName: account.name, secrets: found.secrets };
  p.note([
    `Worker        ${record.name}`,
    `Database      ${record.database.name}`,
    `Backups       ${record.backups ?? "none"}`,
    `Org           ${record.vars.VIBE_ORG ?? "not set"}`,
    `Address       ${record.domain ? `https://${record.domain}` : record.url ?? "unknown"}`,
    `Secrets set   ${found.secrets.join(", ") || "none"}`,
    "",
    "Secrets can't be read back from Cloudflare, so they stay as they are. Replace them from the next menu."
  ].join("\n"), "Found");
  if(!record.vars.OIDC_ISSUER || !record.vars.OIDC_CLIENT_ID) p.warn("This panel is missing OIDC settings. Choose \"Change settings\" to fill them in.");
  return { record, secrets: found.secrets };
}

type Secrets = Partial<Record<"OIDC_CLIENT_SECRET" | "HUB_SIGNING_KEY" | "PANEL_SETUP_TOKEN", string>>;

/** The questions for a panel's settings, with the current ones as defaults. Creates nothing. */
async function configure(deps: WizardDeps, root: string, account: Account, api: CloudflareApi | null, current: HubRecord | null): Promise<HubRecord> {
  const { prompts: p } = deps;
  const vars = { ...current?.vars };

  let name = current?.name;
  if(!name) {
    const taken = new Set([...(await listHubs(root)).filter(h => h.accountId === account.id).map(h => h.name), ...api ? await api.workers(account.id).catch(() => []) : []]);
    name = await p.text({
      message: "Worker name",
      initial: "vibe-panel",
      validate: v => !WORKER_NAME.test(v) ? "Lowercase letters, numbers and dashes" : taken.has(v) ? `${v} already exists in this account` : undefined
    });
  }

  // Resources: shown and confirmed one at a time, and reused when they already exist.
  const database = current?.database ?? await resource(deps, api, account, {
    kind: "D1 database",
    defaultName: name,
    existing: async () => (await api!.databases(account.id)).map(d => ({ name: d.name, id: d.id })),
    create: async n => {
      const args = ["d1", "create", n];
      const result = await runShown(deps, args);
      const id = result.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? (await api?.databases(account.id).catch(() => []))?.find(d => d.name === n)?.id;
      if(!id) throw new Error("The database was created, but its ID couldn't be read. Find it with `wrangler d1 list`.");
      return { name: n, id };
    }
  });

  let backups = current ? current.backups : null;
  if(!current) {
    if(await p.confirm({ message: "Keep daily backups of sites in an R2 bucket?", initial: true })) {
      backups = (await resource(deps, api, account, {
        kind: "R2 bucket",
        defaultName: `${name}-backups`,
        existing: async () => (await api!.buckets(account.id)).map(b => ({ name: b, id: b })),
        create: async n => {
          await runShown(deps, ["r2", "bucket", "create", n]);
          return { name: n, id: n };
        }
      })).name;
    }
  } else if(await p.confirm({ message: backups ? `Backups go to ${backups}. Change that?` : "Backups are off. Turn them on?", initial: false })) {
    const bucket = await p.text({ message: "R2 bucket name (empty for none)", initial: backups ?? `${name}-backups`, validate: v => !v || RESOURCE_NAME.test(v) ? undefined : "3 to 63 characters: lowercase letters, numbers and dashes" });
    if(bucket && bucket !== backups) await runShown(deps, ["r2", "bucket", "create", bucket]);
    backups = bucket || null;
  }

  // The org and sign-in.
  vars.VIBE_ORG = (await p.text({
    message: "Your org's domain (a domain you own, like my-agency.com)",
    initial: vars.VIBE_ORG,
    validate: v => HOSTNAME.test(v.trim()) ? undefined : "Enter a domain like my-agency.com"
  })).trim().toLowerCase();
  p.note("Register an OIDC client with your identity provider (Google, Okta, Entra…) with this redirect URI, once the panel's address is known. It's shown again at the end.", "Sign-in");
  vars.OIDC_ISSUER = (await p.text({ message: "OIDC issuer URL", initial: vars.OIDC_ISSUER ?? "https://accounts.google.com", validate: v => URL.canParse(v) ? undefined : "Enter a URL" })).trim();
  vars.OIDC_CLIENT_ID = (await p.text({ message: "OIDC client ID", initial: vars.OIDC_CLIENT_ID, validate: required("The client ID") })).trim();
  vars.PANEL_ALLOW = (await p.text({ message: "Who may sign in: email domains or group names, comma-separated", initial: vars.PANEL_ALLOW ?? vars.VIBE_ORG, validate: required("This") })).trim();

  // The address: the Worker's own, or a custom domain.
  let domain = current?.domain ?? null;
  const wantsDomain = await p.confirm({ message: domain ? `Keep serving the panel from ${domain}?` : "Serve the panel from your own domain (like admin.my-agency.com)?", initial: Boolean(domain) });
  if(wantsDomain) {
    domain = (await p.text({ message: "Panel hostname", initial: domain ?? `admin.${vars.VIBE_ORG}`, validate: v => HOSTNAME.test(v.trim()) ? undefined : "Enter a hostname like admin.my-agency.com" })).trim().toLowerCase();
    const zone = api ? await api.zoneFor(account.id, domain).catch(() => null) : null;
    if(zone) p.info(`${zone.name} is on this Cloudflare account, so deploying attaches ${domain} as a Worker custom domain: Cloudflare adds the DNS record and certificate.`);
    else {
      p.warn(api ? `${domain} isn't on this Cloudflare account (or wrangler's login can't read zones).` : `Can't check whether ${domain} is on this account.`);
      p.note(`The panel will be reachable at its workers.dev address after this deploy. To use ${domain}, either add the domain to this account and run the wizard again, or point a CNAME for ${domain} at the workers.dev address in your DNS host's settings and attach it under the Worker's Settings → Domains & Routes.`, "Custom domain");
      if(!await p.confirm({ message: `Deploy to workers.dev for now, and keep ${domain} as the intended address?`, initial: true })) throw new Cancelled();
      // Not attached as a route (Cloudflare would refuse a hostname it doesn't host), and not made the panel's
      // address either: sign-in redirects would point at a hostname that doesn't serve it yet.
      domain = null;
      delete vars.PANEL_URL;
    }
  } else {
    domain = null;
  }
  if(domain) delete vars.PANEL_URL;

  return { version: 1, accountId: account.id, accountName: account.name, name, database, backups, vars, domain, url: current?.url, secrets: current?.secrets };
}

async function resource(
  deps: WizardDeps,
  api: CloudflareApi | null,
  _account: Account,
  options: {
    kind: string,
    defaultName: string,
    existing: () => Promise<Array<{ name: string, id: string }>>,
    create: (name: string) => Promise<{ name: string, id: string }>
  }
) {
  const { prompts: p } = deps;
  const name = await p.text({ message: `${options.kind} name`, initial: options.defaultName, validate: v => RESOURCE_NAME.test(v) ? undefined : "3 to 63 characters: lowercase letters, numbers and dashes" });
  const existing = api ? (await options.existing().catch(() => [])).find(r => r.name === name) : undefined;
  if(existing) {
    if(!await p.confirm({ message: `${options.kind} "${name}" already exists. Use it?`, initial: true })) throw new Cancelled();
    return existing;
  }
  if(!await p.confirm({ message: `Create ${options.kind} "${name}"?`, initial: true })) throw new Cancelled();
  return options.create(name);
}

/** Shows a wrangler command, runs it, and stops with wrangler's own message if it fails. */
async function runShown({ exec, prompts: p }: WizardDeps, args: string[]) {
  p.info(`$ ${show(args)}`);
  const result = await exec(args);
  if(result.code) throw new Error(`${show(args)} failed:\n${(result.stderr || result.stdout).trim()}`);
  return result;
}

/** The panel's public address before it's deployed: its custom domain, or its Worker's `workers.dev` address. */
async function addressOf(record: HubRecord, api: CloudflareApi | null): Promise<string | undefined> {
  if(record.domain) return `https://${record.domain}`;
  if(record.vars.PANEL_URL) return record.vars.PANEL_URL;
  const sub = api ? await api.subdomain(record.accountId).catch(() => null) : null;
  return sub ? `https://${record.name}.${sub}.workers.dev` : record.url;
}

async function deploy(deps: WizardDeps, root: string, record: HubRecord, replace: Secrets, existing: string[], api: CloudflareApi | null) {
  const { exec, prompts: p } = deps;
  const url = await addressOf(record, api);
  const needsOwner = url ? await (deps.needsOwner ?? defaultNeedsOwner)(url) : null;

  const secrets: Secrets = { ...replace };
  if(!secrets.OIDC_CLIENT_SECRET && !existing.includes("OIDC_CLIENT_SECRET")) {
    secrets.OIDC_CLIENT_SECRET = await p.password({ message: "OIDC client secret (stored as a Worker secret)", validate: required("The client secret") });
  }
  if(!secrets.HUB_SIGNING_KEY && !existing.includes("HUB_SIGNING_KEY")) secrets.HUB_SIGNING_KEY = await generateHubKey();
  // A panel nobody has claimed gets a fresh link; one already claimed doesn't need it.
  const link = needsOwner === true || needsOwner === null && !existing.includes("PANEL_SETUP_TOKEN");
  if(link) secrets.PANEL_SETUP_TOKEN = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "").slice(0, 8);

  p.note([
    `Worker      ${record.name}`,
    `Address     ${url ?? "its workers.dev address"}${record.domain ? " (custom domain)" : ""}`,
    `Database    ${record.database.name}`,
    `Backups     ${record.backups ?? "off"}`,
    `Org         ${record.vars.VIBE_ORG}`,
    `Sign-in     ${record.vars.OIDC_ISSUER}`,
    `Secrets     ${Object.keys(secrets).map(k => k === "PANEL_SETUP_TOKEN" ? "one-time setup link" : k).join(", ") || "unchanged"}`
  ].join("\n"), "About to deploy");
  if(!await p.confirm({ message: "Deploy now?", initial: true })) throw new Cancelled();

  const dir = await writeHub(root, { ...record, url }, deps.bundle);
  const configPath = path.join(dir, "wrangler.jsonc");
  p.info(`Settings saved in ${dir}`);

  const tmp = await mkdtemp(path.join(tmpdir(), "vibe-panel-"));
  const secretsPath = path.join(tmp, "secrets.json");
  try {
    const args = ["deploy", "--config", configPath, ...Object.keys(secrets).length ? ["--secrets-file", secretsPath] : []];
    if(Object.keys(secrets).length) await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
    p.info(`$ ${show(args.map(a => a === secretsPath ? "<secrets file>" : a))}`);
    const result = await exec(args, { cwd: dir, stream: true });
    if(result.code) throw new Error("wrangler deploy failed (its output is above). Run the wizard again after fixing it.");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  await writeHub(root, { ...record, url, secrets: [...new Set([...existing, ...Object.keys(secrets)])] }, deps.bundle);

  await finish(deps, record, url, secrets.PANEL_SETUP_TOKEN, api);
}

async function finish(deps: WizardDeps, record: HubRecord, url: string | undefined, token: string | undefined, api: CloudflareApi | null) {
  const { prompts: p } = deps;
  const base = url ?? `https://${record.name}.<your-subdomain>.workers.dev`;
  p.note(`Register this at your identity provider if you haven't (the same issuer and client ID you entered):\n\n  ${base}/auth/callback`, "Redirect URI");

  const org = record.vars.VIBE_ORG!;
  const txtName = `_vibe-hub.${org}`;
  const txtValue = base;
  let dnsDone = false;
  if(api) {
    const zone = await api.zoneFor(record.accountId, org).catch(() => null);
    if(zone) {
      const records = await api.txtRecords(zone.id, txtName).catch(() => []);
      if(records.some(r => r.content === txtValue)) {
        p.success(`${txtName} already points at ${txtValue}.`);
        dnsDone = true;
      } else if(records.length) {
        p.warn(`${txtName} already exists and says ${records.map(r => r.content).join(", ")}. It's left alone: change it to ${txtValue} yourself when you're ready to point the org here.`);
        dnsDone = true;
      } else if(await p.confirm({ message: `Add the DNS record ${txtName} TXT "${txtValue}" to ${zone.name} on this account?`, initial: true })) {
        await api.createTxt(zone.id, txtName, txtValue);
        p.success(`Added ${txtName}.`);
        dnsDone = true;
      }
    }
  }
  if(!dnsDone) p.note(`${txtName}   TXT   "${txtValue}"`, "Add this DNS record so sites can find the panel");

  p.note("Sites join with the same org: deploy them with VIBE_ORG set to it, or deploy without and attach each from the claim link it logs (`vibe-cms admin attach`, or the panel's \"Add a site\" box).", "Adding sites");
  if(token) {
    p.note(`${base}/#setup=${token}\n\nOpen it and sign in: you become the panel's owner, and the link stops working. Until then nobody can sign in. Keep it to yourself.`, "Claim the panel");
    p.outro("Panel deployed.");
  } else {
    p.outro(`Panel deployed: ${base}`);
  }
}
