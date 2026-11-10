import type { RoleRules } from "../config.ts";
import type { SiteWarning } from "../handler/images.ts";
import type { PendingDocument } from "../handler/engine.ts";
import { isSameZoneBlock, sameZoneAdvice } from "../org/index.ts";

/** A site as the panel knows it: from its `/.well-known/vibe-cms` descriptor. */
export interface PanelSite {
  id: string,
  url: string,
  name: string,
  admin: string,
  favorite: boolean,
  /** From the site's live descriptor; absent until it's been fetched. */
  accent?: string | null,
  icon?: string | null
}

/** The agency's own look for the panel: its name, accent and logo. */
export interface PanelBranding {
  name: string,
  /** `#rrggbb`; null keeps the neutral default. Also the accent of framed sites that don't set their own. */
  accent: string | null,
  /** Image URL. */
  icon: string | null
}

export const DEFAULT_BRANDING: PanelBranding = { name: "vibe", accent: null, icon: null };

const HEX = /^#[0-9a-f]{6}$/i;

/** Drops anything that isn't a usable value, so bad configuration falls back instead of breaking the page. */
export function normalizeBranding(input: Partial<Record<keyof PanelBranding, unknown>>): PanelBranding {
  return {
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : DEFAULT_BRANDING.name,
    accent: typeof input.accent === "string" && HEX.test(input.accent) ? input.accent.toLowerCase() : null,
    icon: typeof input.icon === "string" && input.icon ? input.icon : null
  };
}

export interface PanelUser {
  /** The identity sites know this person by: `<issuer>|<sub>`. Hosted panels only. */
  sub?: string,
  name?: string,
  email?: string,
  /** The user's hub role (`owner`, `admin`, `member` or a custom one); null when they aren't a member. Hosted panels only. */
  role?: string | null,
  permissions?: HubPermission[],
  /** The hub's owner or an admin: sees and manages every site. */
  admin?: boolean
}

export type HubPermission = "members" | "roles" | "templates" | "addSites" | "removeSites";

/** One role's rules, as a site stores them. */
export type PanelRoleRules = RoleRules;

export interface HubMember {
  id: string,
  sub: string | null,
  email: string | null,
  name: string | null,
  role: string,
  invited: boolean,
  addedAt: number,
  lastSeenAt: number | null,
  managedSites: number,
  assignedSites: string[]
}

export interface HubRole {
  name: string,
  permissions: HubPermission[],
  builtIn: boolean
}

export interface SiteRoleInfo {
  name: string,
  rules: PanelRoleRules,
  updatedBy: string | null,
  updatedAt: number | null,
  stale: string[]
}

export interface SiteAccessInfo {
  site: PanelSite & { addedBy: string | null, addedAt: number | null },
  canManage: boolean,
  /** Whether this person may give people roles here: the site's owners, or someone whose role on it manages roles. */
  canAssign: boolean,
  /** The roles they may give: all of them for owners, else those within their own. */
  assignable: string[],
  me: { admin: boolean },
  owners: Array<{ sub: string, email: string | null, name: string | null, kind: "owner" | "admin" | "grant", grantedAt: number | null, adder: boolean }>,
  people: Array<{ principal: string, email: string | null, name: string | null, invited: boolean, roles: string[] }>,
  /** The site's own roles; null when the user can't manage it or the site couldn't be reached (`rolesError`). */
  roles: SiteRoleInfo[] | null,
  rolesError: string | null,
  template: { id: string | null, name: string | null, state: "applied" | "pending" | "failed", skipped: string[], error: string | null, attempts: number } | null
}

export interface RoleTemplate {
  id: string,
  name: string,
  roles: Record<string, PanelRoleRules>,
  isDefault: boolean,
  updatedBy: string,
  updatedAt: number,
  usedBy: number,
  /** One line per role describing what it may do. */
  summary: Record<string, string>
}

export interface TemplateResult {
  state: "applied" | "pending" | "failed",
  skipped: string[],
  error?: string
}

/** Who administers what on a hosted panel: members, site access, templates. */
export interface PanelHub {
  setup(): Promise<{ needsOwner: boolean }>,
  members(): Promise<{ members: HubMember[], roles: HubRole[], sites: number, permissions: HubPermission[], me: { sub: string, role: string | null, permissions: HubPermission[] } }>,
  invite(email: string, role: string): Promise<void>,
  setMemberRole(id: string, role: string): Promise<void>,
  removeMember(id: string): Promise<void>,
  saveHubRole(name: string, permissions: HubPermission[]): Promise<void>,
  deleteHubRole(name: string): Promise<void>,
  siteAccess(siteId: string): Promise<SiteAccessInfo>,
  assign(siteId: string, who: { email?: string, sub?: string }, roles: string[]): Promise<void>,
  unassign(siteId: string, principal: string): Promise<void>,
  addOwner(siteId: string, sub: string): Promise<void>,
  removeOwner(siteId: string, sub: string): Promise<void>,
  applyTemplate(siteId: string, templateId: string, replace: boolean): Promise<TemplateResult>,
  templates(): Promise<RoleTemplate[]>,
  saveTemplate(id: string | null, input: { name?: string, roles?: Record<string, PanelRoleRules>, isDefault?: boolean }): Promise<RoleTemplate>,
  deleteTemplate(id: string): Promise<void>
}

/** An agent (MCP client) the user connected to the panel. */
export interface PanelAgent {
  id: string,
  name: string,
  readOnly: boolean,
  connectedAt: string,
  lastUsedAt: string | null
}

export interface SiteDescriptor {
  protocol: number,
  id: string,
  name: string,
  accent?: string | null,
  icon?: string | null,
  /** The org whose hub the site trusts (`VIBE_ORG`); null for sites without one (development). */
  org: string | null,
  /** The org's hub, when the site could look it up. */
  hub: string | null,
  /** A pending move to another org, which takes effect at `effectiveAt` unless cancelled. */
  orgMove: { to: string, requestedAt: number, effectiveAt: number } | null,
  /** Whether the site lets its hub take and restore backups. */
  backups: boolean,
  admin: string,
  /** Setup problems a developer should fix, e.g. image optimization failing. Older sites send none. */
  warnings: SiteWarning[]
}

/** When a site is backed up and how many snapshots the panel keeps. */
export interface BackupPolicy {
  enabled: boolean,
  /** Hour of the day (UTC) the daily snapshot is taken. */
  hour: number,
  /** One snapshot per day for this many days, per week for this many weeks, per month for this many months. */
  keepDaily: number,
  keepWeekly: number,
  keepMonthly: number
}

export interface BackupSnapshot {
  /** Its path in the archive. */
  id: string,
  takenAt: number,
  /** `safety`: taken automatically before a restore. */
  kind: "scheduled" | "manual" | "safety",
  documents: number,
  files: number,
  bytes: number,
  warnings: string[]
}

export interface BackupRun {
  id: string,
  kind: "scheduled" | "manual" | "restore",
  status: "queued" | "running" | "done" | "failed",
  /** The snapshot it took, or for a restore, the one it restores. */
  snapshot: string | null,
  attempts: number,
  progress: { step: string, [key: string]: unknown } | null,
  error: string | null,
  requestedBy: string | null,
  createdAt: number,
  startedAt: number | null,
  finishedAt: number | null,
  /** When a failed attempt is tried again. */
  retryAt: number | null
}

export interface SiteBackups {
  /** False when the panel has no archive bucket. */
  available: boolean,
  /** This hub's org, which the site names in `VIBE_ORG`. */
  panel: string | null,
  /** Whether the site lets this panel back it up; null when the site couldn't be reached. */
  trusted: boolean | null,
  /** The org the site does trust, when it's another. */
  trustedPanel: string | null,
  /** The site's own policy; null when it follows the panel's defaults. */
  policy: BackupPolicy | null,
  effective: BackupPolicy,
  nextAt: number | null,
  snapshots: BackupSnapshot[],
  runs: BackupRun[]
}

/** The hosted panel's backups. */
export interface PanelBackups {
  status(): Promise<{ available: boolean, panel: string | null, defaults: BackupPolicy }>,
  setDefaults(policy: BackupPolicy): Promise<void>,
  site(siteId: string): Promise<SiteBackups>,
  /** `null` goes back to the panel's defaults. */
  setPolicy(siteId: string, policy: BackupPolicy | null): Promise<SiteBackups>,
  backUp(siteId: string): Promise<void>,
  /** Where a snapshot downloads as one `.vibe` file. */
  downloadUrl(snapshotId: string): string,
  restore(siteId: string, snapshotId: string): Promise<void>
}

/**
 * Where the panel keeps its state. The hosted panel talks to its own backend
 * (OIDC sign-in, shared site list in D1); the local panel keeps the list in
 * localStorage and relies on development sites signing editors in themselves.
 */
export interface PanelBackend {
  mode: "hosted" | "local",
  /** Public, so the sign-in page carries the agency's look too. */
  branding(): Promise<PanelBranding>,
  me(): Promise<PanelUser | null>,
  sites(): Promise<PanelSite[]>,
  /** `templateId`: undefined for the panel's default template, null for none. Hosted panels only. */
  addSite(url: string, templateId?: string | null): Promise<PanelSite & { template?: TemplateResult | null }>,
  /**
   * Attaches a site from its claim link: the panel tells the site which org it belongs to, then adds it.
   * Hosted panels only; `templateId` as for `addSite`.
   */
  attachSite?(link: string, templateId?: string | null): Promise<PanelSite & { template?: TemplateResult | null }>,
  removeSite(id: string): Promise<void>,
  setFavorite(id: string, favorite: boolean): Promise<void>,
  /** A one-time code for the framed site. `null` when the site signs in by itself (development). */
  codeFor(siteId: string): Promise<string | null>,
  signInUrl?: string,
  signOut?(): Promise<void>,
  /** The panel's MCP address and the agents this user connected. Hosted panels only. */
  agents?(): Promise<{ mcpUrl: string, agents: PanelAgent[] }>,
  disconnectAgent?(id: string): Promise<void>,
  /** Scheduled backups. Hosted panels only. */
  backups?: PanelBackups,
  /** Members, site access and templates. Hosted panels only. */
  hub?: PanelHub,
  /** Unpublished changes across sites. Hosted panels only. */
  review?(): Promise<PanelReview>
}

/** What awaits publishing on each site this person can see. A site that couldn't be asked has an `error`. */
export interface PanelReview {
  sites: Array<{ site: { id: string, name: string }, documents: PendingDocument[], error?: string }>
}

export class PanelError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** The origin of a typed site address. Without a scheme it's HTTPS, except for local dev servers, which only speak HTTP. */
/** Whether what was pasted is a site's claim link (`…#claim=…`) and not just its address. */
export function isClaimLink(text: string): boolean {
  return /#claim=\S+/.test(text.trim());
}

export function siteOrigin(url: string): string {
  url = url.trim();
  if(/^https?:\/\//.test(url)) return new URL(url).origin;
  const { hostname } = new URL(`http://${url}`);
  const local = hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  return new URL(`${local ? "http" : "https"}://${url}`).origin;
}

export async function fetchDescriptor(url: string): Promise<SiteDescriptor> {
  let origin: string;
  try {
    origin = siteOrigin(url);
  } catch {
    throw new PanelError(400, "That doesn't look like a URL");
  }
  let response: Response;
  try {
    response = await fetch(`${origin}/.well-known/vibe-cms`);
  } catch {
    throw new PanelError(502, `Couldn't reach ${origin}`);
  }
  if(!response.ok) {
    if(isSameZoneBlock(await response.text().catch(() => ""))) throw new PanelError(502, sameZoneAdvice(origin));
    throw new PanelError(422, `${origin} isn't a Vibe CMS site (no /.well-known/vibe-cms)`);
  }
  const descriptor = await response.json() as SiteDescriptor;
  if(descriptor.protocol !== 1 || !descriptor.id || !descriptor.admin) throw new PanelError(422, "Unsupported site descriptor");
  return {
    ...descriptor,
    org: descriptor.org ?? null,
    hub: descriptor.hub ?? null,
    orgMove: descriptor.orgMove ?? null,
    warnings: Array.isArray(descriptor.warnings) ? descriptor.warnings : []
  };
}

const STORAGE_KEY = "vibe-panel:sites";

/** The local panel (`vibe-cms admin`): no identity provider, sites in localStorage. */
export function localBackend(branding: Partial<PanelBranding> = {}): PanelBackend {
  function read(): PanelSite[] {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as PanelSite[];
    } catch {
      return [];
    }
  }
  function write(sites: PanelSite[]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sites));
  }
  return {
    mode: "local",
    branding: async () => normalizeBranding(branding),
    me: async () => ({ name: "Local developer" }),
    sites: async () => read(),
    async addSite(url) {
      const descriptor = await fetchDescriptor(url);
      const site: PanelSite = {
        id: descriptor.id,
        url: new URL(descriptor.admin).origin,
        name: descriptor.name,
        admin: descriptor.admin,
        favorite: false
      };
      write([...read().filter(s => s.id !== site.id), site]);
      return site;
    },
    async removeSite(id) {
      write(read().filter(s => s.id !== id));
    },
    async setFavorite(id, favorite) {
      write(read().map(s => (s.id === id ? { ...s, favorite } : s)));
    },
    codeFor: async () => null
  };
}
