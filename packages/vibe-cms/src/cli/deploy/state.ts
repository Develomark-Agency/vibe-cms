import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Set on every panel Worker the wizard deploys, so it can be found again on Cloudflare. */
export const PANEL_MARKER = "VIBE_PANEL";

/** What the wizard knows about one deployed (or about-to-be-deployed) panel. No secrets. */
export interface HubRecord {
  version: 1,
  accountId: string,
  accountName?: string,
  /** The Worker's name. */
  name: string,
  database: { name: string, id: string },
  /** The R2 bucket for scheduled backups, or null to run without backups. */
  backups: string | null,
  /** Plain-text variables: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `PANEL_ALLOW`, `VIBE_ORG`, `PANEL_URL`, `OIDC_ROLES_CLAIM`, white-labelling. */
  vars: Record<string, string>,
  /** The hostname attached as a Worker custom domain, if any. */
  domain: string | null,
  /** Where the panel can be reached, for the setup link. */
  url?: string,
  /** Secrets known to be set on the Worker (their names), so a redeploy doesn't replace them. */
  secrets?: string[]
}

/** What `vibe-cms build:panel` writes beside the bundle: what the panel's own build decided. */
export interface BundleManifest {
  compatibility_date: string,
  compatibility_flags: string[],
  run_worker_first: string[],
  crons: string[]
}

export interface Bundle {
  dir: string,
  manifest: BundleManifest
}

/** Where the wizard keeps its hubs: `$VIBE_CMS_HOME`, else `$XDG_CONFIG_HOME` or `~/.config`, then `vibe-cms/panels`. */
export function configRoot(env: Record<string, string | undefined> = process.env): string {
  if(env.VIBE_CMS_HOME) return path.join(env.VIBE_CMS_HOME, "panels");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "vibe-cms", "panels");
}

export function hubDir(root: string, accountId: string, name: string) {
  return path.join(root, accountId, name);
}

export async function writeHub(root: string, record: HubRecord, bundle: Bundle) {
  const dir = hubDir(root, record.accountId, record.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "hub.json"), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path.join(dir, "wrangler.jsonc"), renderWrangler(record, bundle));
  return dir;
}

export async function readHub(root: string, accountId: string, name: string): Promise<HubRecord | null> {
  try {
    return JSON.parse(await readFile(path.join(hubDir(root, accountId, name), "hub.json"), "utf8")) as HubRecord;
  } catch {
    return null;
  }
}

export async function removeHub(root: string, accountId: string, name: string) {
  await rm(hubDir(root, accountId, name), { recursive: true, force: true });
}

/** Every hub on this machine, across accounts. Unreadable folders are skipped. */
export async function listHubs(root: string): Promise<HubRecord[]> {
  const hubs: HubRecord[] = [];
  for(const account of await readdir(root).catch(() => [] as string[])) {
    for(const name of await readdir(path.join(root, account)).catch(() => [] as string[])) {
      const record = await readHub(root, account, name);
      if(record) hubs.push(record);
    }
  }
  return hubs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Worker's config, written from the record every time so it never drifts from what the wizard
 * showed. It points at the panel bundle inside the installed package, so upgrading `vibe-cms` and
 * running the wizard again is the upgrade path.
 */
export function renderWrangler(record: HubRecord, bundle: Bundle): string {
  const { manifest } = bundle;
  const config = {
    $schema: "https://workers.cloudflare.com/wrangler-config-schema.json",
    name: record.name,
    main: path.join(bundle.dir, "index.js"),
    no_bundle: true,
    compatibility_date: manifest.compatibility_date,
    ...manifest.compatibility_flags.length ? { compatibility_flags: manifest.compatibility_flags } : {},
    assets: {
      directory: path.join(bundle.dir, "client"),
      binding: "ASSETS",
      run_worker_first: manifest.run_worker_first,
      not_found_handling: "single-page-application"
    },
    d1_databases: [{ binding: "DB", database_name: record.database.name, database_id: record.database.id }],
    ...record.backups ? { r2_buckets: [{ binding: "BACKUPS", bucket_name: record.backups }] } : {},
    triggers: { crons: manifest.crons },
    vars: { [PANEL_MARKER]: "1", ...record.vars },
    ...record.domain ? { routes: [{ pattern: record.domain, custom_domain: true }] } : {}
  };
  return `// Written by \`vibe-cms admin deploy\`. Run it again to change anything here.\n${JSON.stringify(config, null, 2)}\n`;
}
