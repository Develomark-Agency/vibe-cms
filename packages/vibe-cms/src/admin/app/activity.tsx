import { useInfiniteQuery } from "@tanstack/react-query";
import { ActivityIcon, ArrowUpRightIcon, ChevronRightIcon, DownloadIcon, SearchIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { ActivityEntry, ActivityFilter, Via } from "../../handler/activity.ts";
import { Button } from "../components/ui/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Tip } from "../components/ui/tooltip.tsx";
import { cn } from "../lib/utils.ts";
import type { SessionState } from "./client.ts";
import { collectionLabel, displayUser, formatDate, formatRelative, localeName, useAdmin } from "./context.tsx";
import { Delayed, useArrival } from "./delayed.tsx";
import { Collapse } from "./fields.tsx";
import { Link } from "./router.tsx";

/** What people see for an action's name. Anything not here (plugin actions) shows its name. */
const LABELS: Record<string, string> = {
  "documents.create": "Created",
  "documents.update": "Edited",
  "documents.delete": "Deleted",
  "documents.publish": "Published",
  "documents.unpublish": "Unpublished",
  "documents.restoreVersion": "Restored a version of",
  "documents.schedule": "Scheduled",
  "documents.unschedule": "Unscheduled",
  "assets.upload": "Uploaded",
  "assets.update": "Edited",
  "assets.delete": "Deleted",
  "assets.replaceContent": "Replaced",
  "assets.stripMetadata": "Removed photo details from",
  "folders.create": "Created folder",
  "folders.move": "Moved folder",
  "folders.delete": "Deleted folder",
  "trash.restore": "Restored",
  "trash.purge": "Deleted for good",
  "trash.empty": "Emptied the trash",
  "trash.purgeExpired": "Purged expired trash",
  "site.update": "Changed site settings",
  "backups.manifest": "Started a backup",
  "backups.export": "Read backup data",
  "backups.files": "Listed backup files",
  "activity.list": "Looked at others' activity",
  "users.list": "Listed people",
  "users.invite": "Invited someone",
  "users.update": "Changed roles of",
  "users.remove": "Removed",
  "roles.save": "Saved role",
  "roles.delete": "Deleted role",
  "roles.apply": "Applied a role template",
  "auth.signIn": "Signed in",
  "auth.signOut": "Signed out"
};

/** Failed actions read as attempts: "Delete Pricing", refused. */
const ATTEMPTS: Record<string, string> = {
  "documents.create": "Create",
  "documents.update": "Edit",
  "documents.delete": "Delete",
  "documents.publish": "Publish",
  "documents.unpublish": "Unpublish",
  "assets.delete": "Delete",
  "trash.purge": "Delete for good",
  "activity.list": "See others' activity"
};

export const VIA_LABELS: Record<Via, string> = {
  ui: "Editor",
  rest: "API",
  mcp: "Agent (MCP)",
  cli: "CLI",
  plugin: "Plugin",
  cron: "Schedule",
  hub: "Hub"
};

/** Known MCP clients by the start of their user agent; anything else is just "an agent". */
const AGENTS: Array<[RegExp, string]> = [
  [/^claude-code\b/i, "Claude Code"],
  [/^claude/i, "Claude"],
  [/^cursor/i, "Cursor"],
  [/^codex/i, "Codex"],
  [/^windsurf/i, "Windsurf"],
  [/^(vscode|visual-studio-code)/i, "VS Code"],
  [/^zed/i, "Zed"],
  [/^goose/i, "Goose"],
  [/^chatgpt|^openai/i, "ChatGPT"]
];

export function agentName(client: string | null): string {
  if(!client) return "an agent";
  return AGENTS.find(([pattern]) => pattern.test(client))?.[1] ?? "an agent";
}

/** The person responsible, and how they acted when it wasn't by hand: "Ada Lovelace via Claude Code". */
function userParts(entry: ActivityEntry, session: SessionState): { user: string, via: string | null } {
  if(entry.actor === "system:cron") return { user: entry.onBehalfOf ? displayUser(entry.onBehalfOf, session) : "Scheduled", via: entry.onBehalfOf ? "schedule" : null };
  if(entry.actor === "system:hub") return { user: "Hub", via: null };
  const user = entry.actor === session.user.sub ? "You" : entry.actorName ?? displayUser(entry.actor, session);
  if(entry.via === "mcp") return { user, via: agentName(entry.client) };
  return { user, via: null };
}

function userText(entry: ActivityEntry, session: SessionState): string {
  const { user, via } = userParts(entry, session);
  return via ? `${user} via ${via}` : user;
}

function actionWord(entry: ActivityEntry): string {
  const name = entry.action.replace(/^plugin:/, "");
  return (entry.ok ? LABELS[entry.action] : ATTEMPTS[entry.action] ?? LABELS[entry.action]) ?? name;
}

function targetText(entry: ActivityEntry): string {
  return entry.targetLabel ?? entry.targetId ?? "";
}

function startOfDay(date: Date, daysBack = 0): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysBack).getTime();
}

function clock(date: Date, seconds: boolean): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
}

/** 10:47:12 today, "Yest. 18:00", else "12 Nov 14:08". */
function when(at: number): string {
  const date = new Date(at);
  const now = new Date();
  if(at >= startOfDay(now)) return clock(date, true);
  if(at >= startOfDay(now, 1)) return `Yest. ${clock(date, false)}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${clock(date, false)}`;
}

const GRID = "grid grid-cols-[7.5rem_minmax(0,15rem)_minmax(0,1fr)_5.5rem] gap-3";

/** The activity ledger: one row per entry, newest first, a page at a time; a row opens to its details. */
export function ActivityList({ filter, text = "", compact = false, onEntries }: {
  filter: ActivityFilter,
  /** Narrows the loaded rows by user, action and target. */
  text?: string,
  compact?: boolean,
  onEntries?(entries: ActivityEntry[]): void
}) {
  const { cms, config, session } = useAdmin();
  const [open, setOpen] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["activity", filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => cms.actions.activity.list({ ...filter, ...(pageParam ? { cursor: pageParam } : {}) } as Parameters<typeof cms.actions.activity.list>[0]),
    getNextPageParam: page => page.next ?? undefined
  });
  const arrival = useArrival(!query.isLoading);
  const loaded = useMemo(() => query.data?.pages.flatMap(page => page.entries) ?? [], [query.data]);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const entries = useMemo(() => (words.length
    ? loaded.filter(entry => {
      const haystack = `${userText(entry, session)} ${actionWord(entry)} ${targetText(entry)} ${entry.action}`.toLowerCase();
      return words.every(word => haystack.includes(word));
    })
    : loaded), [loaded, session, text]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onEntries?.(entries);
  }, [entries, onEntries]);

  function targetLink(entry: ActivityEntry): string | null {
    if(!entry.targetId) return null;
    if(entry.targetType && config.schemas[entry.targetType]) return `/content/${entry.targetType}/${entry.targetId}${entry.locale ? `?locale=${entry.locale}` : ""}`;
    if(entry.targetType === "assets") return `/media?file=${entry.targetId}`;
    return null;
  }

  function targetKind(entry: ActivityEntry): string | null {
    if(entry.targetType && config.schemas[entry.targetType]) return collectionLabel(config, entry.targetType, false);
    if(entry.targetType === "assets") return "File";
    return null;
  }

  if(query.isLoading) return <Delayed><div className="space-y-2">{Array.from({ length: compact ? 3 : 6 }, (_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div></Delayed>;
  if(query.isError) return <p className="text-sm text-destructive">{(query.error as Error).message}</p>;
  if(entries.length === 0) {
    return (
      <Empty className="rounded-[16px] well">
        <EmptyHeader>
          <EmptyMedia variant="icon"><ActivityIcon /></EmptyMedia>
          <EmptyTitle>No activity</EmptyTitle>
          <EmptyDescription>{words.length || Object.keys(filter).length > 1 ? "Nothing matches these filters." : "Changes made in the editor, by agents, the CLI and the API show up here."}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const grid = compact ? "grid grid-cols-[7.5rem_minmax(0,1fr)_4.5rem] gap-3" : GRID;
  return (
    <div className="flex flex-col gap-3">
      <div className={cn("overflow-hidden rounded-[16px] elevated text-sm [&>button:nth-last-child(2)]:border-b-0 [&>:last-child_dl]:border-b-0", arrival)} role="table" aria-label="Activity">
        <div role="row" className={cn(grid, "border-b px-4 py-2.5 eyebrow")}>
          <span role="columnheader">Time</span>
          {!compact && <span role="columnheader">User</span>}
          <span role="columnheader">Action</span>
          <span role="columnheader" className="text-right">Result</span>
        </div>
        {entries.map(entry => {
          const { user, via } = userParts(entry, session);
          const expanded = open === entry.id;
          const link = targetLink(entry);
          const fields = Array.isArray(entry.summary?.fields) ? entry.summary.fields as string[] : [];
          return (
            <Fragment key={entry.id}>
              <button
                type="button"
                role="row"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : entry.id)}
                className={cn(grid, "w-full items-center border-b px-4 py-2.5 text-left hover:bg-foreground/[0.03]", !entry.ok && "bg-destructive/[0.04]")}
              >
                <span role="cell" className="flex items-center gap-1 whitespace-nowrap text-muted-foreground tabular-nums">
                  <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform duration-200", expanded && "rotate-90")} aria-hidden />
                  <Tip label={formatRelative(entry.at)}><span>{when(entry.at)}</span></Tip>
                </span>
                {!compact && (
                  <span role="cell" className="truncate">
                    {user}{via && <><span className="text-muted-foreground"> via </span><span className="font-medium">{via}</span></>}
                  </span>
                )}
                <span role="cell" className="truncate">
                  <span className="font-medium">{actionWord(entry)}</span> {targetText(entry)}
                  {typeof entry.summary?.ver === "number" && <span className="text-muted-foreground"> · v{entry.summary.ver as number}</span>}
                  {compact && <span className="text-muted-foreground"> · {userText(entry, session)}</span>}
                </span>
                <span role="cell" className={cn("text-right", entry.ok ? "text-emerald-700 dark:text-emerald-400" : "font-medium text-destructive")}>
                  {entry.ok ? "OK" : entry.error === "FORBIDDEN" ? "Refused" : "Failed"}
                </span>
              </button>
              <Collapse open={expanded}>
                <dl className={cn("grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b bg-foreground/[0.02] py-3 pr-4 text-xs", compact ? "pl-[9.25rem]" : "pl-[9.25rem] md:pl-[25rem]")}>
                  <dt className="text-muted-foreground">Action</dt><dd className="font-mono">{entry.action}</dd>
                  {entry.targetId && (
                    <>
                      <dt className="text-muted-foreground">{targetKind(entry) ?? "Target"}</dt>
                      <dd>
                        {entry.targetLabel && <>{entry.targetLabel} · </>}
                        {entry.locale && config.locales!.length > 1 && <>{localeName(entry.locale)} · </>}
                        <span className="font-mono text-muted-foreground">{entry.targetId}</span>
                      </dd>
                    </>
                  )}
                  {fields.length > 0 && (
                    <>
                      <dt className="text-muted-foreground">Fields</dt>
                      <dd className="flex flex-wrap gap-1">{fields.map(field => <span key={field} className="rounded-[5px] bg-foreground/[0.06] px-1.5">{field}</span>)}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Channel</dt>
                  <dd>{VIA_LABELS[entry.via as Via] ?? entry.via}{entry.client ? ` · ${entry.client}` : ""}</dd>
                  {entry.onBehalfOf && <><dt className="text-muted-foreground">Set up by</dt><dd>{displayUser(entry.onBehalfOf, session)}</dd></>}
                  {!entry.ok && <><dt className="text-muted-foreground">Error</dt><dd className="text-destructive">{entry.error === "FORBIDDEN" ? "Not allowed by their role" : entry.error}</dd></>}
                  <dt className="text-muted-foreground">When</dt><dd><Tip label={formatRelative(entry.at)}><span className="cursor-default">{formatDate(entry.at)}</span></Tip></dd>
                  {link && (
                    <><dt /><dd className="pt-1.5">
                      <Button variant="outline" size="xs" nativeButton={false} render={<Link to={link} />}>
                        Open {targetKind(entry)?.toLowerCase() ?? "it"} <ArrowUpRightIcon data-icon="inline-end" />
                      </Button>
                    </dd></>
                  )}
                </dl>
              </Collapse>
            </Fragment>
          );
        })}
      </div>
      {query.hasNextPage && (
        <Button variant="outline" className="self-center" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {query.isFetchingNextPage && <Spinner />} Load older
        </Button>
      )}
    </div>
  );
}

// --- Filters ---------------------------------------------------------------------------------

/** One filter chip: typed as `key:value` in the filter bar. */
type Token = { key: "via" | "since" | "action" | "user" | "result", value: string };

const SINCE: Record<string, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const VIA_ALIASES: Record<string, Via> = { editor: "ui", ui: "ui", api: "rest", rest: "rest", agent: "mcp", mcp: "mcp", cli: "cli", plugin: "plugin", schedule: "cron", cron: "cron", hub: "hub" };

const SUGGESTIONS = ["via:agent", "via:editor", "via:cli", "via:api", "since:24h", "since:30d", "since:all", "action:documents", "action:assets", "result:refused", "user:me"];

function parseToken(word: string): Token | null {
  const match = /^(via|since|action|user|result):(\S+)$/i.exec(word.trim());
  if(!match) return null;
  const key = match[1]!.toLowerCase() as Token["key"];
  const value = match[2]!.toLowerCase();
  if(key === "via" && !VIA_ALIASES[value]) return null;
  if(key === "since" && !SINCE[value] && value !== "all") return null;
  if(key === "result" && !["refused", "failed", "ok"].includes(value)) return null;
  if(key === "user" && value !== "me") return null;
  return { key, value: key === "action" ? match[2]! : value };
}

function toFilter(tokens: Token[], me: string): ActivityFilter {
  const filter: ActivityFilter = {};
  let since: number | undefined = SINCE["7d"];
  for(const { key, value } of tokens) {
    if(key === "via") filter.via = VIA_ALIASES[value];
    if(key === "action") filter.action = value;
    if(key === "user") filter.actor = me;
    if(key === "result") filter.ok = value === "ok";
    if(key === "since") since = SINCE[value];
  }
  // Rounded to the minute so the query key holds still while the page is open.
  if(since) filter.since = Math.floor((Date.now() - since) / 60_000) * 60_000;
  return filter;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function csv(entries: ActivityEntry[], session: SessionState): string {
  const header = ["time", "user", "actor", "via", "client", "on_behalf_of", "action", "target_type", "target_id", "target", "locale", "ok", "error", "summary"];
  const rows = entries.map(e => [new Date(e.at).toISOString(), userText(e, session), e.actor, e.via, e.client, e.onBehalfOf, e.action, e.targetType, e.targetId, e.targetLabel, e.locale, e.ok, e.error, e.summary]);
  return [header, ...rows].map(row => row.map(csvCell).join(",")).join("\n");
}

/** The site's activity log: everyone's for people who may see it, otherwise the signed-in person's own. */
export function ActivityPage() {
  const { session, site } = useAdmin();
  const everyone = session.permissions.activity === true;
  const [tokens, setTokens] = useState<Token[]>([]);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState<ActivityEntry[]>([]);

  useEffect(() => {
    document.title = `Activity · ${site.name}`;
  }, [site.name]);

  const filter = toFilter(tokens, session.user.sub);
  const since = tokens.find(t => t.key === "since")?.value ?? "7d";
  const refused = shown.filter(entry => entry.error === "FORBIDDEN").length;

  function add(word: string): boolean {
    const token = parseToken(word);
    if(!token) return false;
    setTokens(current => [...current.filter(t => t.key !== token.key), token]);
    return true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if(event.key === "Backspace" && draft === "" && tokens.length) {
      setTokens(current => current.slice(0, -1));
      return;
    }
    if(event.key !== "Enter" && event.key !== " ") return;
    const last = draft.split(/\s+/).pop() ?? "";
    if(add(last)) {
      event.preventDefault();
      setDraft(draft.slice(0, draft.length - last.length).trimEnd());
    }
  }

  function exportCsv() {
    const blob = new Blob([csv(shown, session)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const suggestions = SUGGESTIONS.filter(s => !tokens.some(t => s.startsWith(`${t.key}:`)) && s.startsWith(draft.split(/\s+/).pop() ?? "") && (everyone || !s.startsWith("user:")));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-medium tracking-[-0.025em]" data-shared="title">Activity</h1>
          <p className="text-sm text-muted-foreground">
            {everyone ? "Who changed what on this site, and how." : "What you changed on this site, and how."}
            {" "}{since === "all" ? "All time" : `Last ${since === "24h" ? "24 hours" : since === "7d" ? "7 days" : "30 days"}`}
            {refused > 0 && <> · <span className="text-destructive">{refused} refused</span></>}
          </p>
        </div>
        <Button variant="outline" disabled={shown.length === 0} onClick={exportCsv}><DownloadIcon /> Export CSV</Button>
      </div>

      <div className="relative">
        <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-[12px] bg-background px-3 py-1.5 shadow-[0_0_0_1px_var(--border)] focus-within:shadow-[0_0_0_2px_var(--ring)]">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {tokens.map(token => (
            <span key={token.key} className="inline-flex h-6 items-center gap-1 rounded-[6px] bg-foreground/[0.07] pl-2 pr-1 text-xs">
              {token.key}:{token.value}
              <button type="button" aria-label={`Remove ${token.key} filter`} className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setTokens(current => current.filter(t => t !== token))}><XIcon className="size-3" /></button>
            </span>
          ))}
          <label htmlFor="activity-filter" className="sr-only">Filter activity</label>
          <input
            id="activity-filter"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={tokens.length ? "" : "Filter by user, document, action… or via:agent, since:30d"}
            className="h-8 min-w-40 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {focused && suggestions.length > 0 && (
          <div className="absolute inset-x-0 top-full z-20 mt-1 flex flex-wrap gap-1.5 rounded-[12px] bg-popover p-2 shadow-lg ring-1 ring-foreground/10">
            {suggestions.map(suggestion => (
              <button
                key={suggestion}
                type="button"
                className="rounded-[6px] bg-foreground/[0.05] px-2 py-1 text-xs hover:bg-foreground/[0.1]"
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  add(suggestion);
                  setDraft(current => current.split(/\s+/).slice(0, -1).join(" "));
                }}
              >{suggestion}</button>
            ))}
          </div>
        )}
      </div>

      <ActivityList filter={filter} text={draft} onEntries={setShown} />
    </div>
  );
}
