import { QueryClient, QueryClientProvider, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  BotIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ShieldAlertIcon,
  StarIcon,
  SunIcon,
  Trash2Icon,
  UsersIcon
} from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, MotionConfig, useMotionValue, useSpring } from "motion/react";
import { StrictMode, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Button } from "../admin/components/ui/button.tsx";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Command } from "../admin/components/ui/command.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../admin/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "../admin/components/ui/dropdown-menu.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../admin/components/ui/empty.tsx";
import { Input } from "../admin/components/ui/input.tsx";
import { Kbd } from "../admin/components/ui/kbd.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../admin/components/ui/popover.tsx";
import { Toaster } from "../admin/components/ui/sonner.tsx";
import { Skeleton } from "../admin/components/ui/skeleton.tsx";
import { Spinner } from "../admin/components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../admin/components/ui/tooltip.tsx";
import { SiteMark as SharedSiteMark } from "../admin/components/site-mark.tsx";
import { cn } from "../admin/lib/utils.ts";
import { ErrorBoundary } from "../admin/app/error-boundary.tsx";
import type { EditorMessage, PanelMessage } from "../admin/app/session.ts";
import { getTheme, isTheme, setAccent, setFavicon, setTheme, startTheme, subscribeTheme, useTheme, type Theme } from "../admin/app/theme.ts";
import { Delayed } from "../admin/app/delayed.tsx";
import { ConfirmHost } from "../admin/app/confirm.tsx";
import { BackupDefaultsDialog, BackupsDialog } from "./backups.tsx";
import { go, listeners, useRoute } from "./location.ts";
import { AccessPage, PeoplePage, SetupCard, TemplatePicker, TemplatesPage } from "./access.tsx";
import type { SiteWarning } from "../handler/images.ts";
import { DEFAULT_BRANDING, fetchDescriptor, isClaimLink, PanelError, type PanelBackend, type PanelBranding, type PanelSite, type PanelUser } from "./backend.ts";

/**
 * Clicks inside the framed editor never reach this document, so popups can't
 * see them as outside clicks, and focus (and Escape) moves into the frame.
 * Close when the window loses focus to an iframe.
 */
function useCloseOnFrameFocus(open: boolean, close: () => void) {
  useEffect(() => {
    if(!open) return;
    function onBlur() {
      // activeElement updates after blur fires.
      setTimeout(() => {
        if(document.activeElement instanceof HTMLIFrameElement) close();
      });
    }
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [open]);
}

function sortSites<T extends PanelSite>(sites: T[]): T[] {
  return [...sites].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
}

/** The shared mark at panel sizes; without an accent, a colour derived from the site's ID tells sites apart. */
function SiteMark({ site, className }: { site: PanelSite, className?: string }) {
  let hue = 0;
  for(const char of site.id) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return <SharedSiteMark name={site.name} icon={site.icon} color={site.accent ?? `oklch(0.55 0.15 ${hue})`} className={cn("size-6 rounded-[6px] text-[10px]", className)} />;
}

/** The agency's logo, else the first letter of its name on the accent. */
function PanelMark({ branding, className }: { branding: PanelBranding, className?: string }) {
  if(branding.icon) return <img src={branding.icon} alt="" className={cn("aspect-square shrink-0 object-cover", className)} />;
  return <span className={cn("flex aspect-square shrink-0 items-center justify-center raised-brand font-semibold", className)}>{branding.name.charAt(0).toLowerCase()}</span>;
}

/** Names, accents and icons change on the sites themselves; the stored list is only the fallback. */
type LiveSite = PanelSite & {
  /** Why the site's descriptor couldn't be read: not answering at all, or answering but not as vibe-cms. */
  problem?: { kind: "offline" | "invalid", message: string },
  /** A check of the site is in flight. */
  checking?: boolean,
  /** Not checked yet: whether it's up, and its live name, aren't known. */
  pending?: boolean,
  /** Setup problems the site reports, e.g. image optimization failing. */
  warnings?: SiteWarning[]
};

function siteProblem(error: unknown): LiveSite["problem"] {
  return { kind: error instanceof PanelError && error.status === 502 ? "offline" : "invalid", message: (error as Error).message };
}

// A long list would open a connection per site at once; check a few at a time, with a breath between.
const CHECKS_AT_ONCE = 6;
let checksRunning = 0;
const checkQueue: Array<() => void> = [];

function throttledCheck<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    function run() {
      checksRunning++;
      task().then(resolve, reject).finally(() => setTimeout(() => {
        checksRunning--;
        checkQueue.shift()?.();
      }, 100));
    }
    if(checksRunning < CHECKS_AT_ONCE) run();
    else checkQueue.push(run);
  });
}

function useLiveSites(sites: PanelSite[] | undefined): LiveSite[] | undefined {
  const descriptors = useQueries({
    queries: (sites ?? []).map(site => ({
      queryKey: ["descriptor", site.id],
      queryFn: () => throttledCheck(() => fetchDescriptor(site.url)),
      // Sites are checked once when the list loads. A site that's down isn't polled (that adds up
      // with hundreds of sites); hovering its card checks it again (see useRecheck).
      staleTime: 60_000,
      retry: false
    }))
  });
  return sites?.map((site, i) => {
    const { data: live, error, isFetching } = descriptors[i] ?? {};
    if(live) return { ...site, name: live.name, accent: live.accent ?? null, icon: live.icon ?? null, warnings: live.warnings };
    if(error) return { ...site, problem: siteProblem(error), checking: isFetching };
    return { ...site, pending: true };
  });
}

/** Checks a site that's down again once the pointer settles on it; repeat hovers inside a few seconds share one check. */
function useRecheck() {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    start(site: LiveSite) {
      clearTimeout(timer.current);
      if(!site.problem) return;
      timer.current = setTimeout(() => {
        const queryKey = ["descriptor", site.id];
        const state = queryClient.getQueryState(queryKey);
        if(state?.fetchStatus === "fetching" || Date.now() - (state?.errorUpdatedAt ?? 0) < 3_000) return;
        void queryClient.refetchQueries({ queryKey, exact: true });
      }, 250);
    },
    cancel() {
      clearTimeout(timer.current);
    }
  };
}

/** Healthy sites first, so the ones that can't be opened right now don't crowd the top. */
/**
 * Whether the first checks have come back, or waiting for them has gone on long enough. Sites are
 * ordered by name and health, both known only after a check, so cards shown before then would
 * rise in one order and then shuffle into another.
 */
function useSettled(pending: boolean, ms = 800): boolean {
  const [settled, setSettled] = useState(!pending);
  useEffect(() => {
    if(settled) return;
    if(!pending) return setSettled(true);
    const timer = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(timer);
  }, [pending, settled, ms]);
  return settled || !pending;
}

function healthyFirst<T extends LiveSite>(sites: T[]): T[] {
  return [...sites].sort((a, b) => Number(!!a.problem) - Number(!!b.problem));
}

function ProblemBadge({ site }: { site: LiveSite }) {
  if(!site.problem) return null;
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-destructive">
      <span className="size-1.5 rounded-full bg-current" />
      {site.problem.kind === "offline" ? "Not running" : <>Not <span className="whitespace-nowrap">Vibe CMS</span></>}
    </span>
  );
}

function useBranding(backend: PanelBackend): PanelBranding {
  const branding = useQuery({ queryKey: ["branding"], queryFn: () => backend.branding(), staleTime: Infinity }).data ?? DEFAULT_BRANDING;
  useEffect(() => {
    setAccent(branding.accent);
    setFavicon(branding.icon);
  }, [branding.accent, branding.icon]);
  return branding;
}

// --- App ----------------------------------------------------------------------------

function Panel({ backend }: { backend: PanelBackend }) {
  const me = useQuery({ queryKey: ["me"], queryFn: () => backend.me(), retry: false });
  const branding = useBranding(backend);
  if(me.isLoading) return <Delayed><div className="flex h-full items-center justify-center"><Spinner className="size-5" /></div></Delayed>;
  if(me.isError) return <div className="flex h-full items-center justify-center text-sm text-destructive">{(me.error as Error).message}</div>;
  const setup = /^#setup=(.+)$/.exec(location.hash)?.[1];
  if(!me.data && setup && backend.signInUrl) return <SetupCard branding={branding} signInUrl={backend.signInUrl} token={decodeURIComponent(setup)} />;
  if(!me.data) return <SignIn backend={backend} branding={branding} />;
  return <Shell backend={backend} branding={branding} user={me.data} />;
}

function SignIn({ backend, branding }: { backend: PanelBackend, branding: PanelBranding }) {
  const error = new URLSearchParams(location.search).get("error");
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => backend.hub!.setup(), enabled: Boolean(backend.hub), retry: false });
  return (
    <div className="flex h-full items-center justify-center bg-sidebar p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-[24px] elevated px-8 py-10 text-center">
        {branding.icon ? <PanelMark branding={branding} className="size-12 rounded-[14px]" /> : (
          <div className="flex size-12 items-center justify-center rounded-[14px] raised-brand">
            <KeyRoundIcon className="size-5" />
          </div>
        )}
        <div className="space-y-2">
          <p className="eyebrow">{branding.name === DEFAULT_BRANDING.name ? "Panel" : branding.name}</p>
          <h1 className="text-xl font-medium tracking-tight">Sign in to your sites</h1>
          <p className="text-sm text-muted-foreground">One sign-in for every site your agency manages.</p>
        </div>
        {error && <p className="w-full rounded-[12px] bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        {setup.data?.needsOwner && !error && (
          <p className="w-full rounded-[12px] well px-3 py-2 text-sm text-muted-foreground">This panel has no owner yet. Open the setup link printed in its logs to claim it.</p>
        )}
        <Button size="lg" className="w-full" render={<a href={`${backend.signInUrl}?return=${encodeURIComponent(location.pathname)}`} />} nativeButton={false}>
          Continue with your identity provider
        </Button>
      </div>
    </div>
  );
}

function Shell({ backend, branding, user }: { backend: PanelBackend, branding: PanelBranding, user: PanelUser }) {
  const queryClient = useQueryClient();
  const { siteId, rest, page, accessId } = useRoute();
  const hub = backend.hub;
  const canAdd = !hub || (user.permissions?.includes("addSites") ?? false);
  const panelPages = hub ? [
    { key: null, label: "Sites", to: "/" },
    ...(user.role ? [{ key: "people", label: "People", to: "/people" }] : []),
    ...(user.permissions?.includes("templates") || user.role ? [{ key: "templates", label: "Templates", to: "/templates" }] : [])
  ] : [];
  const [addOpen, setAddOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [backupsFor, setBackupsFor] = useState<PanelSite | null>(null);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  function openBackups(target: PanelSite) {
    setBackupsFor(target);
    setBackupsOpen(true);
  }
  useCloseOnFrameFocus(accountOpen, () => setAccountOpen(false));
  useCloseOnFrameFocus(paletteOpen, () => setPaletteOpen(false));
  const sites = useQuery({ queryKey: ["sites"], queryFn: () => backend.sites() });
  const live = useLiveSites(sites.data);
  const site = live?.find(s => s.id === siteId) ?? null;
  const [theme] = useTheme();

  const favorite = useMutation({
    mutationFn: ({ id, value }: { id: string, value: boolean }) => backend.setFavorite(id, value),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sites"] })
  });

  // `?site=http://localhost:1337` adds and opens a site (used by `vibe-cms admin`).
  useEffect(() => {
    const url = new URLSearchParams(location.search).get("site");
    if(!url) return;
    backend.addSite(url).then(
      added => {
        void queryClient.invalidateQueries({ queryKey: ["sites"] });
        history.replaceState(null, "", `/s/${encodeURIComponent(added.id)}/`);
        listeners.forEach(l => l());
      },
      (error: Error) => toast.error(error.message)
    );
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if(!site) document.title = `Sites · ${branding.name}`;
  }, [site, branding.name]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
        <button onClick={() => go("/")} className="flex items-center gap-2 rounded-[10px] py-1 pr-2 pl-1 text-sm font-semibold tracking-tight transition-[background-color,scale] duration-150 hover:bg-foreground/[0.05] active:scale-[0.97]">
          <PanelMark branding={branding} className="size-6 rounded-[7px] text-[11px]" />
          <span className="hidden sm:inline">{branding.name}</span>
        </button>
        <span className="text-muted-foreground/40">/</span>
        <SiteSwitcher sites={live ?? []} current={site} onAdd={canAdd ? () => setAddOpen(true) : undefined} />
        {site && hub && (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Access" onClick={() => go(`/sites/${encodeURIComponent(site.id)}/access`)}><UsersIcon /></Button>} />
            <TooltipContent>People and roles</TooltipContent>
          </Tooltip>
        )}
        {!site && panelPages.length > 1 && (
          <nav className="ml-2 hidden items-center gap-1 sm:flex" aria-label="Panel">
            {panelPages.map(item => {
              const active = item.key === page && !accessId;
              return (
                <Button key={item.to} variant="ghost" size="sm" aria-current={active ? "page" : undefined} className={cn("text-muted-foreground", active && "bg-foreground/[0.06] text-foreground")} onClick={() => go(item.to)}>
                  {item.label}
                </Button>
              );
            })}
          </nav>
        )}
        {site && (
          <>
            <Tooltip>
              <TooltipTrigger render={
                <Button variant="ghost" size="icon-sm" aria-label={site.favorite ? "Remove from favorites" : "Add to favorites"}
                  onClick={() => favorite.mutate({ id: site.id, value: !site.favorite })}>
                  <StarIcon className={cn(site.favorite && "fill-amber-400 text-amber-400")} />
                </Button>
              } />
              <TooltipContent>{site.favorite ? "Favorite" : "Add to favorites"}</TooltipContent>
            </Tooltip>
            {backend.backups && (
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Backups" onClick={() => openBackups(site)}><ArchiveIcon /></Button>} />
                <TooltipContent>Backups</TooltipContent>
              </Tooltip>
            )}
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" className="hidden pr-1 text-muted-foreground sm:flex" onClick={() => setPaletteOpen(true)}>
            Jump to… <Kbd>⌘K</Kbd>
          </Button>
          {backend.mode === "local" && <span className="hidden rounded-full well px-2 py-0.5 text-xs text-muted-foreground sm:inline">Local</span>}
          <DropdownMenu open={accountOpen} onOpenChange={setAccountOpen}>
            <DropdownMenuTrigger render={
              <Button variant="ghost" size="icon-sm" aria-label="Account" className="rounded-full raised text-xs font-medium">
                {(user.name ?? user.email ?? "?").charAt(0).toUpperCase()}
              </Button>
            } />
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate">{user.email ?? user.name}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>{theme === "dark" ? <MoonIcon /> : theme === "light" ? <SunIcon /> : <MonitorIcon />} Theme</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={theme} onValueChange={next => setTheme(next as Theme)}>
                    <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {backend.agents && (
                <DropdownMenuItem onClick={() => setAgentsOpen(true)}><BotIcon /> AI agents</DropdownMenuItem>
              )}
              {backend.backups && (
                <DropdownMenuItem onClick={() => setDefaultsOpen(true)}><ArchiveIcon /> Backup schedule</DropdownMenuItem>
              )}
              {backend.signOut && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={async () => {
                    await backend.signOut!();
                    location.href = "/";
                  }}><LogOutIcon /> Sign out</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="relative min-h-0 flex-1">
        {hub && accessId ? (
          <div className="h-full overflow-y-auto"><AccessPage key={accessId} hub={hub} siteId={accessId} site={live?.find(s => s.id === accessId) ?? null} /></div>
        ) : hub && page === "people" ? (
          <div className="h-full overflow-y-auto"><PeoplePage hub={hub} user={user} /></div>
        ) : hub && page === "templates" ? (
          <div className="h-full overflow-y-auto"><TemplatesPage hub={hub} user={user} /></div>
        ) : siteId === null ? (
          <SiteList backend={backend} sites={live} loading={sites.isLoading} canAdd={canAdd} member={!hub || Boolean(user.role)} onAdd={() => setAddOpen(true)} onBackups={backend.backups ? openBackups : undefined} />
        ) : site ? (
          <SiteFrame key={site.id} backend={backend} branding={branding} site={site} initialPath={rest} onShortcut={() => setPaletteOpen(true)} />
        ) : sites.isLoading ? (
          <Delayed><div className="flex h-full items-center justify-center"><Spinner /></div></Delayed>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">This site isn't in the list.</div>
        )}
      </main>
      <AddSiteDialog backend={backend} open={addOpen} onOpenChange={setAddOpen} />
      {backend.agents && <AgentsDialog backend={backend} open={agentsOpen} onOpenChange={setAgentsOpen} />}
      {backend.backups && (
        <>
          <BackupsDialog backups={backend.backups} site={backupsFor} open={backupsOpen} onOpenChange={setBackupsOpen} />
          <BackupDefaultsDialog backups={backend.backups} open={defaultsOpen} onOpenChange={setDefaultsOpen} />
        </>
      )}
      <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <Command>
          <CommandInput placeholder="Switch to a site…" />
          <CommandList>
            <CommandEmpty>No sites found.</CommandEmpty>
            <CommandGroup heading="Sites">
              {sortSites(live ?? []).map(s => (
                <CommandItem key={s.id} value={`${s.name} ${s.url}`} onSelect={() => {
                  setPaletteOpen(false);
                  go(`/s/${encodeURIComponent(s.id)}/`);
                }}>
                  <SiteMark site={s} className="size-5" />
                  <span className={cn("min-w-0 flex-1 truncate", s.problem && "text-muted-foreground")}>{s.name}</span>
                  <ProblemBadge site={s} />
                  {s.favorite && <StarIcon className="fill-amber-400 text-amber-400" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Panel">
              <CommandItem onSelect={() => {
                setPaletteOpen(false);
                go("/");
              }}><LayoutGridIcon /> All sites</CommandItem>
              {canAdd && (
                <CommandItem onSelect={() => {
                  setPaletteOpen(false);
                  setAddOpen(true);
                }}><PlusIcon /> Add a site</CommandItem>
              )}
              {panelPages.filter(item => item.key).map(item => (
                <CommandItem key={item.to} onSelect={() => {
                  setPaletteOpen(false);
                  go(item.to);
                }}><UsersIcon /> {item.label}</CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
      <Toaster position="bottom-right" />
      <ConfirmHost />
    </div>
  );
}

function SiteSwitcher({ sites, current, onAdd }: { sites: LiveSite[], current: LiveSite | null, onAdd?(): void }) {
  const [open, setOpen] = useState(false);
  useCloseOnFrameFocus(open, () => setOpen(false));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={
        <Button variant="ghost" size="sm" className="min-w-0 max-w-72 gap-2 px-1.5 font-medium">
          {current ? <SiteMark site={current} /> : <LayoutGridIcon />}
          <span className="truncate">{current?.name ?? "All sites"}</span>
          <ChevronsUpDownIcon className="text-muted-foreground" />
        </Button>
      } />
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Find a site…" />
          <CommandList>
            <CommandEmpty>No sites.</CommandEmpty>
            <CommandGroup>
              {sortSites(sites).map(site => (
                <CommandItem key={site.id} value={`${site.name} ${site.url}`} data-checked={current?.id === site.id} onSelect={() => {
                  setOpen(false);
                  go(`/s/${encodeURIComponent(site.id)}/`);
                }}>
                  <SiteMark site={site} className="size-5" />
                  <span className={cn("min-w-0 flex-1 truncate", site.problem && "text-muted-foreground")}>{site.name}</span>
                  <ProblemBadge site={site} />
                  {site.favorite && <StarIcon className="fill-amber-400 text-amber-400" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup>
              <CommandItem onSelect={() => {
                setOpen(false);
                go("/");
              }}><LayoutGridIcon /> All sites</CommandItem>
              {onAdd && (
                <CommandItem onSelect={() => {
                  setOpen(false);
                  onAdd();
                }}><PlusIcon /> Add a site…</CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SiteList({ backend, sites, loading, canAdd, member, onAdd, onBackups }: {
  backend: PanelBackend,
  sites: LiveSite[] | undefined,
  loading: boolean,
  /** Whether the user may add sites; members of the hub without it, and people with only site roles, can't. */
  canAdd: boolean,
  member: boolean,
  onAdd(): void,
  onBackups?(site: PanelSite): void
}) {
  const [filter, setFilter] = useState("");
  const portal = usePortalHover();
  const settled = useSettled(!sites || sites.some(s => s.pending));
  if(loading) return <Delayed><div className="flex h-full items-center justify-center"><Spinner /></div></Delayed>;
  const hosted = backend.mode === "hosted";
  const all = sortSites(sites ?? []);
  const list = all.filter(s => `${s.name} ${s.url}`.toLowerCase().includes(filter.toLowerCase()));
  const starred = healthyFirst(list.filter(s => s.favorite));
  const others = healthyFirst(list.filter(s => !s.favorite));
  const starredCount = all.filter(s => s.favorite).length;
  return (
    <div className="h-full overflow-y-auto md:grid md:grid-cols-[minmax(18rem,22rem)_1fr] md:overflow-hidden">
      <aside className="flex flex-col gap-8 border-b px-4 pt-12 pb-8 md:h-full md:overflow-y-auto md:border-r md:border-b-0 md:px-10">
        <div className="space-y-3">
          <p className="eyebrow">{hosted ? "Agency workspace" : "Local workspace"}</p>
          <h1 className="text-4xl font-medium tracking-[-0.03em]">Sites</h1>
          <p className="text-sm text-muted-foreground">
            {hosted ? "Every site this panel manages. Each site decides who can edit it." : "Development sites on this machine, all in one place."}
          </p>
        </div>
        <dl className="flex gap-8 border-t pt-6">
          <div>
            <dd className="text-2xl font-medium tabular-nums">{all.length}</dd>
            <dt className="text-xs text-muted-foreground">{all.length === 1 ? "Site" : "All sites"}</dt>
          </div>
          <div>
            <dd className="text-2xl font-medium tabular-nums">{starredCount}</dd>
            <dt className="text-xs text-muted-foreground">Starred</dt>
          </div>
        </dl>
        {canAdd && <AddSiteForm backend={backend} />}
        <p className="mt-auto text-xs text-muted-foreground">
          {hosted ? <>Sites need <span className="whitespace-nowrap">Vibe CMS</span> and must trust this panel's identity provider.</> : "This list is stored in this browser only."}
        </p>
      </aside>
      <div className="overflow-x-clip md:h-full md:overflow-y-auto">
        <div className="mx-auto flex max-w-5xl relative flex-col gap-8 px-4 pt-12 pb-12 md:px-10">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-xl font-medium tracking-[-0.02em]">Your sites</h2>
              <p className="text-sm text-muted-foreground">Open a site to edit its content.</p>
            </div>
            {all.length > 0 && <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search sites…" className="w-full sm:w-64" aria-label="Search sites" />}
          </div>
          {all.length === 0 ? (
            <Empty className="rounded-[16px] well">
              <EmptyHeader>
                <EmptyMedia variant="icon"><GlobeIcon /></EmptyMedia>
                <EmptyTitle>{canAdd ? "No sites yet" : "No sites for you yet"}</EmptyTitle>
                <EmptyDescription>
                  {!canAdd
                    ? member ? "Sites show up here once someone gives you a role on one." : "You're signed in, but nobody has given you a role on a site yet. Ask whoever runs this panel."
                    : hosted ? <>Add a site by its URL. It needs <span className="whitespace-nowrap">Vibe CMS</span> and has to trust the same identity provider as this panel.</> : "Start a site's dev server, then add its address, like localhost:4321."}
                </EmptyDescription>
              </EmptyHeader>
              {canAdd && <EmptyContent><Button onClick={onAdd}><PlusIcon /> Add your first site</Button></EmptyContent>}
            </Empty>
          ) : !settled ? (
            // Held back while the first checks come in (useSettled); quick enough not to need a spinner.
            null
          ) : list.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No sites match “{filter}”.</p>
          ) : (
            // One layout group, so a card that's starred flies from its grid to the other one.
            <MotionConfig reducedMotion="user"><LayoutGroup>
              <AnimatePresence initial={false} mode="popLayout">
                {starred.length > 0 && <SiteGroup key="starred" title="Starred" sites={starred} backend={backend} portal={portal} onBackups={onBackups} />}
                {starred.length > 0 && others.length > 0 && <motion.hr key="divider" layout {...fade} />}
                {others.length > 0 && <SiteGroup key="others" title={starred.length ? "Other sites" : "All sites"} sites={others} backend={backend} portal={portal} onBackups={onBackups} offset={starred.length} />}
              </AnimatePresence>
            </LayoutGroup></MotionConfig>
          )}
        </div>
      </div>
      <SitePortal state={portal} />
    </div>
  );
}

// Hover preview: one floating window shared by every card, so moving between sites
// swaps the page inside it instead of tearing it down. Pages stay loaded once seen.
const PORTAL = { width: 268, height: 168, scale: 268 / 1280, gap: 20 };

type PortalHover = ReturnType<typeof usePortalHover>;

function usePortalHover() {
  const [site, setSite] = useState<LiveSite | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  function place(e: { clientX: number, clientY: number }) {
    // Right of and below the cursor, flipped when that would leave the viewport.
    const right = e.clientX + PORTAL.gap + PORTAL.width > window.innerWidth;
    const below = e.clientY + PORTAL.gap + PORTAL.height > window.innerHeight;
    x.set(right ? e.clientX - PORTAL.gap - PORTAL.width : e.clientX + PORTAL.gap);
    y.set(below ? Math.max(8, e.clientY - PORTAL.gap - PORTAL.height) : e.clientY + PORTAL.gap);
  }
  return {
    site, x, y,
    enter(next: LiveSite, e: React.PointerEvent) {
      if(e.pointerType !== "mouse") return;
      clearTimeout(leave.current);
      if(!site) place(e);
      setSite(next);
    },
    move(e: React.PointerEvent) {
      if(e.pointerType === "mouse") place(e);
    },
    // A short grace period, so crossing the gap between cards doesn't blink the window.
    leave() {
      clearTimeout(leave.current);
      leave.current = setTimeout(() => setSite(null), 120);
    }
  };
}

function SitePortal({ state }: { state: PortalHover }) {
  const springy = { stiffness: 400, damping: 40, mass: 0.6 };
  const x = useSpring(state.x, springy);
  const y = useSpring(state.y, springy);
  const [loaded, setLoaded] = useState<LiveSite[]>([]);
  const site = state.site;
  if(site && !loaded.some(s => s.id === site.id)) setLoaded([...loaded.slice(-4), site]);
  // Jump to the cursor rather than gliding in from wherever it was last hidden.
  const visible = useRef(false);
  if(site && !visible.current) {
    x.jump(state.x.get());
    y.jump(state.y.get());
  }
  visible.current = !!site;
  return createPortal(
    <AnimatePresence>
      {site && (
        <motion.div
          aria-hidden
          className="pointer-events-none fixed top-0 left-0 z-50 overflow-hidden rounded-[14px] bg-background shadow-2xl ring-1 ring-foreground/10"
          style={{ x, y, width: PORTAL.width, height: PORTAL.height }}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.92 }}
          transition={spring}
        >
          {loaded.map(s => (
            <iframe
              key={s.id}
              src={s.url}
              title={`${s.name} preview`}
              tabIndex={-1}
              loading="eager"
              className="absolute top-0 left-0 origin-top-left border-0 transition-opacity duration-150"
              style={{
                width: PORTAL.width / PORTAL.scale,
                height: PORTAL.height / PORTAL.scale,
                transform: `scale(${PORTAL.scale})`,
                opacity: s.id === site.id ? 1 : 0
              }}
            />
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

const spring = { type: "spring", duration: 0.4, bounce: 0.12 } as const;
const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: spring };

function SiteGroup({ title, sites, backend, portal, onBackups, offset = 0, ref }: {
  title: string,
  sites: LiveSite[],
  backend: PanelBackend,
  portal: PortalHover,
  onBackups?(site: PanelSite): void,
  offset?: number,
  ref?: Ref<HTMLElement>
}) {
  const queryClient = useQueryClient();
  const recheck = useRecheck();
  // Cards rise in one after another when the page opens; later arrivals come in at once.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <motion.section ref={ref} layout="position" className="grid gap-3" {...fade}>
      <h3 className="flex items-baseline gap-2 text-sm font-medium">{title} <span className="font-normal text-muted-foreground tabular-nums">{sites.length}</span></h3>
      <div className="relative grid gap-3 lg:grid-cols-2">
        <AnimatePresence mode="popLayout">
          {sites.map((site, i) => (
            <motion.div
              key={site.id}
              layoutId={site.id}
              layout
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ ...spring, delay: mounted.current ? 0 : Math.min(i + offset, 12) * 0.03, layout: spring }}
              onPointerEnter={e => {
                recheck.start(site);
                if(!site.problem) portal.enter(site, e);
              }}
              onPointerMove={portal.move}
              onPointerLeave={() => {
                recheck.cancel();
                portal.leave();
              }}
              className="group/card relative flex items-center gap-3 rounded-[18px] elevated p-2.5 transition-[box-shadow,scale] duration-200 ease-out hover:shadow-(--shadow-raised-hover) has-[[data-open-site]:active]:scale-[0.985]"
            >
              <SiteMark site={site} className={cn("size-11 rounded-[8px] text-sm transition-[filter,opacity]", site.problem && "opacity-30 grayscale")} />
              <button data-open-site className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-[18px] focus-visible:after:ring-3 focus-visible:after:ring-ring/50" onClick={() => go(`/s/${encodeURIComponent(site.id)}/`)}>
                <span className={cn("block truncate font-medium", site.problem && "text-muted-foreground")}>{site.name}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {site.problem && (
                    <Tooltip>
                      <TooltipTrigger render={
                        <span className="relative z-10 inline-flex shrink-0 items-center gap-1.5 font-medium text-destructive">
                          <span className="size-1.5 rounded-full bg-current" />
                          {site.checking ? "Checking…" : site.problem.kind === "offline" ? "Not running" : <>Not a <span className="whitespace-nowrap">Vibe CMS</span> site</>}
                        </span>
                      } />
                      <TooltipContent>{site.problem.message}</TooltipContent>
                    </Tooltip>
                  )}
                  {!site.problem && site.warnings?.length ? (
                    <Tooltip>
                      <TooltipTrigger render={
                        <span className="relative z-10 inline-flex shrink-0 items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                          <span className="size-1.5 rounded-full bg-current" />
                          {site.warnings.length === 1 ? "1 warning" : `${site.warnings.length} warnings`}
                        </span>
                      } />
                      <TooltipContent className="max-w-xs">
                        {site.warnings.map(w => <p key={w.code}>{w.message}</p>)}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {(site.problem || !!site.warnings?.length) && <span aria-hidden>·</span>}
                  <span className="truncate">{new URL(site.url).host}</span>
                </span>
              </button>
              {/* Same 44px square and 8px corner as the mark: both sit 10px inside the 18px card. */}
              <div className="relative z-10 flex items-center">
                <Button variant="ghost" size="icon-sm" className="size-11 rounded-[8px]" aria-label={site.favorite ? "Unstar" : "Star"} onClick={async () => {
                  await backend.setFavorite(site.id, !site.favorite);
                  void queryClient.invalidateQueries({ queryKey: ["sites"] });
                }}>
                  <StarIcon className={cn(site.favorite ? "fill-amber-400 text-amber-400" : "opacity-0 group-hover/card:opacity-100")} />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-11 rounded-[8px]" aria-label="Site actions"><MoreHorizontalIcon /></Button>} />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => window.open(site.url, "_blank", "noopener")}><GlobeIcon /> Visit site</DropdownMenuItem>
                    {backend.hub && <DropdownMenuItem onClick={() => go(`/sites/${encodeURIComponent(site.id)}/access`)}><UsersIcon /> People and roles</DropdownMenuItem>}
                    {onBackups && <DropdownMenuItem onClick={() => onBackups(site)}><ArchiveIcon /> Backups</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={async () => {
                      try {
                        await backend.removeSite(site.id);
                        void queryClient.invalidateQueries({ queryKey: ["sites"] });
                      } catch (error) {
                        toast.error((error as Error).message);
                      }
                    }}><Trash2Icon /> Remove from list</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}

function useAddSite(backend: PanelBackend, url: string, onAdded: () => void, templateId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    // A claim link attaches a site that doesn't belong to an org yet; an address adds one that does.
    mutationFn: () => (isClaimLink(url) && backend.attachSite ? backend.attachSite(url.trim(), templateId) : backend.addSite(url.trim(), templateId)),
    onSuccess: site => {
      void queryClient.invalidateQueries({ queryKey: ["sites"] });
      onAdded();
      const template = site.template;
      const verb = isClaimLink(url) ? "Attached" : "Added";
      if(template?.state === "pending") toast.warning(`${verb} ${site.name}. Its starting roles will be written once the site can be reached.`);
      else if(template?.state === "failed") toast.error(`${verb} ${site.name}, but its starting roles couldn't be written: ${template.error}`);
      else if(template?.skipped.length) toast.success(`${verb} ${site.name}. ${template.skipped.length} ${template.skipped.length === 1 ? "rule" : "rules"} skipped: ${template.skipped.join("; ")}`);
      else toast.success(`${verb} ${site.name}`);
      go(`/s/${encodeURIComponent(site.id)}/`);
    }
  });
}

/** The sidebar's inline version of the add dialog. */
function AddSiteForm({ backend }: { backend: PanelBackend }) {
  const [url, setUrl] = useState("");
  const add = useAddSite(backend, url, () => setUrl(""));
  const hosted = backend.mode === "hosted";
  return (
    <form onSubmit={e => {
      e.preventDefault();
      add.mutate();
    }} className="grid gap-3">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Add a site</h2>
        <p className="text-sm text-muted-foreground">
          {hosted
            ? <>Paste the address of a site running <span className="whitespace-nowrap">Vibe CMS</span>, or the claim link from a new site.</>
            : "Enter the address of a running dev server."}
        </p>
      </div>
      <div className="flex gap-2">
        <Input value={url} onChange={e => {
          setUrl(e.target.value);
          if(add.isError) add.reset();
        }} placeholder={hosted ? "client-site.com" : "localhost:4321"} aria-label="Site URL or claim link" className="min-w-0 flex-1" />
        <Button type="submit" disabled={!url.trim() || add.isPending}>{add.isPending && <Spinner />} Add</Button>
      </div>
      {add.isError && <p className="text-sm text-destructive">{(add.error as Error).message}</p>}
    </form>
  );
}

function AddSiteDialog({ backend, open, onOpenChange }: { backend: PanelBackend, open: boolean, onOpenChange(open: boolean): void }) {
  const [url, setUrl] = useState("");
  const [templateId, setTemplateId] = useState<string | null | undefined>(undefined);
  const add = useAddSite(backend, url, () => {
    onOpenChange(false);
    setUrl("");
    setTemplateId(undefined);
  }, templateId);
  return (
    <Dialog open={open} onOpenChange={next => {
      onOpenChange(next);
      if(!next) add.reset();
    }}>
      <DialogContent>
        <form onSubmit={e => {
          e.preventDefault();
          add.mutate();
        }} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a site</DialogTitle>
            <DialogDescription>
              Paste the site's address. The panel reads its <code className="text-xs">/.well-known/vibe-cms</code> and checks that it trusts this panel's org.
              {backend.attachSite && <> A site deployed without an org logs a claim link instead (ending in <code className="text-xs">#claim=…</code>): paste that, and the panel attaches it to your org.</>}
            </DialogDescription>
          </DialogHeader>
          <Input autoFocus value={url} onChange={e => setUrl(e.target.value)} placeholder={backend.attachSite ? "https://client-site.com, or its claim link" : "https://client-site.com"} aria-label="Site URL or claim link" />
          {add.isError && <p className="text-sm text-destructive">{(add.error as Error).message}</p>}
          {backend.hub && open && <TemplatePicker hub={backend.hub} value={templateId} onChange={setTemplateId} />}
          {backend.hub && <p className="text-xs text-muted-foreground">You'll own this site and can change its roles at any time. The panel's admins can too.</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!url.trim() || add.isPending}>{add.isPending && <Spinner />} {isClaimLink(url) ? "Attach site" : "Add site"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** How to connect an agent (one address for every site), and the agents already connected. */
function AgentsDialog({ backend, open, onOpenChange }: { backend: PanelBackend, open: boolean, onOpenChange(open: boolean): void }) {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => backend.agents!(), enabled: open });
  const [copied, setCopied] = useState(false);
  const disconnect = useMutation({
    mutationFn: (id: string) => backend.disconnectAgent!(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
    onError: (error: Error) => toast.error(error.message)
  });
  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  const mcpUrl = agents.data?.mcpUrl ?? `${location.origin}/mcp`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>AI agents</DialogTitle>
          <DialogDescription>
            Add this address to Claude, ChatGPT or another agent as a custom connector (MCP server). You'll sign in and approve it,
            then it can work on any site here, with the permissions you have on each.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={mcpUrl} aria-label="MCP address" onFocus={e => e.currentTarget.select()} className="font-mono text-xs" />
          <Button variant="outline" onClick={() => void copy(mcpUrl)}>{copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}</Button>
        </div>
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Connected</h3>
          {agents.isLoading ? <Delayed><div className="flex justify-center p-4"><Spinner /></div></Delayed>
            : agents.data?.agents.length ? (
              <ul className="grid gap-1">
                {agents.data.agents.map(agent => (
                  <li key={agent.id} className="flex items-center gap-3 rounded-[10px] well px-3 py-2">
                    <BotIcon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{agent.name}{agent.readOnly && <span className="ml-2 text-xs font-normal text-muted-foreground">Read only</span>}</div>
                      <div className="text-xs text-muted-foreground">
                        Connected {new Date(agent.connectedAt).toLocaleDateString()}
                        {agent.lastUsedAt && ` · last used ${new Date(agent.lastUsedAt).toLocaleDateString()}`}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate(agent.id)}>Disconnect</Button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No agents yet.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the editor looks like before it has loaded: its menu bar and the page it
 * opens on, in skeleton form, drawn the moment the frame starts loading so the
 * panel never shows an empty body. Not wrapped in `Delayed`: the editor takes
 * long enough to arrive that this is always worth showing.
 */
function EditorShell({ dashboard }: { dashboard: boolean }) {
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden bg-background">
      <div className="flex h-14 items-center gap-2 px-4">
        <Skeleton className="h-8 w-32 rounded-[10px]" />
        <Skeleton className="h-8 w-24 rounded-[10px]" />
        <Skeleton className="h-8 w-20 rounded-[10px]" />
        <Skeleton className="ml-3 h-8 w-20 rounded-[10px]" />
        <Skeleton className="h-8 w-20 rounded-[10px]" />
        <Skeleton className="h-8 w-16 rounded-[10px]" />
      </div>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-6 md:px-8">
        <div className="flex flex-col gap-3 pt-6">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-9 w-72 max-w-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        {dashboard ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[6.25rem] rounded-[16px]" />)}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-11 rounded-[12px]" />)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Frames one site's editor and speaks the panel ↔ editor protocol with it. */
function SiteFrame({ backend, branding, site, initialPath, onShortcut }: {
  backend: PanelBackend,
  branding: PanelBranding,
  site: LiveSite,
  initialPath: string,
  onShortcut(): void
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const queryClient = useQueryClient();
  const origin = new URL(site.admin).origin;
  const host = new URL(site.url).host;
  // A site the list already saw answering is framed at once; anything else is checked first, so a
  // site that's down shows as down within a second instead of after the editor's handshake times out.
  function knownUp() {
    return !!queryClient.getQueryState(["descriptor", site.id])?.data && !site.problem;
  }
  const [state, setState] = useState<"connecting" | "trouble" | "loading" | "ready" | "denied" | "unreachable">(() => knownUp() ? "loading" : site.problem ? "trouble" : "connecting");
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry: checks again from the start and reloads the frame.
  const [attempt, setAttempt] = useState(0);
  const framed = state === "loading" || state === "ready" || state === "denied" || (state === "unreachable" && error === null);
  // `ready` only means the editor's handshake began; its interface follows once its code has loaded.
  // The editor says when that has painted (`vibe:painted`); an older one that doesn't is revealed after a moment.
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    if(state !== "ready") {
      setPainted(false);
      return;
    }
    const timer = setTimeout(() => setPainted(true), 2500);
    return () => clearTimeout(timer);
  }, [state, attempt]);
  const revealed = state === "ready" && painted;
  // The placeholder stays under the editor until its fade-in has finished, so the two cross-fade instead of the page flashing.
  const [shellDone, setShellDone] = useState(false);
  useEffect(() => {
    if(!revealed) {
      setShellDone(false);
      return;
    }
    const timer = setTimeout(() => setShellDone(true), 320);
    return () => clearTimeout(timer);
  }, [revealed]);
  const showShell = state === "connecting" || state === "loading" || (state === "ready" && !shellDone);
  // The src is fixed per site; later navigation happens inside the editor and is mirrored here.
  const src = useMemo(() => `${site.admin}${initialPath.startsWith("/") ? initialPath : `/${initialPath}`}`, [site.id]);

  function post(message: PanelMessage) {
    frame.current?.contentWindow?.postMessage(message, origin);
  }
  function sendAppearance() {
    post({ type: "vibe:appearance", theme: getTheme(), accent: branding.accent });
  }

  // The editor follows the panel's theme, and the panel follows changes made in the editor.
  useEffect(() => subscribeTheme(sendAppearance), [site.id, branding.accent]);
  useEffect(sendAppearance, [branding.accent]);

  // Check the site with backoff (about half a minute in all) before framing it.
  useEffect(() => {
    if(state !== "connecting" && state !== "trouble") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check(failures: number) {
      try {
        const descriptor = await fetchDescriptor(site.url);
        if(cancelled) return;
        queryClient.setQueryData(["descriptor", site.id], descriptor);
        setState("loading");
      } catch (e) {
        if(cancelled) return;
        const problem = siteProblem(e)!;
        if(problem.kind !== "offline" || failures >= CHECK_BACKOFF.length) {
          setError(problem.kind === "offline" ? `${host} isn't responding. Check that the site is running, then try again.` : problem.message);
          setState("unreachable");
          return;
        }
        // One miss can be a server mid-restart; after two, say so while we keep trying.
        if(failures >= 1) setState("trouble");
        timer = setTimeout(() => check(failures + 1), CHECK_BACKOFF[failures]);
      }
    }
    void check(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [site.id, attempt]);

  useEffect(() => {
    if(state !== "loading") return;
    const timeout = setTimeout(() => setState(s => (s === "loading" ? "unreachable" : s)), 20_000);
    return () => clearTimeout(timeout);
  }, [state === "loading", attempt]);

  function retry() {
    setError(null);
    setState(knownUp() ? "loading" : "connecting");
    setAttempt(a => a + 1);
  }

  useEffect(() => {
    async function onMessage(event: MessageEvent) {
      if(event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data as EditorMessage;
      switch(message?.type) {
        case "vibe:ready":
          sendAppearance();
          setState("ready");
          break;
        case "vibe:painted":
          setPainted(true);
          break;
        case "vibe:theme":
          if(isTheme(message.theme)) setTheme(message.theme);
          break;
        case "vibe:site":
          queryClient.setQueryData(["descriptor", site.id], (old: object | undefined) => old && {
            ...old,
            name: message.site.name,
            accent: message.site.accent,
            icon: message.site.icon?.url ?? null
          });
          break;
        case "vibe:needCode":
          try {
            // Codes are only ever minted for, and sent to, the framed site.
            const code = await backend.codeFor(site.id);
            if(code) post({ type: "vibe:code", code });
          } catch (e) {
            setError((e as Error).message);
            setState(e instanceof PanelError && e.status === 403 ? "denied" : "unreachable");
          }
          break;
        case "vibe:navigated":
          if(typeof message.path === "string" && message.path.startsWith("/")) {
            history.replaceState(null, "", `/s/${encodeURIComponent(site.id)}${message.path}`);
          }
          break;
        case "vibe:title":
          if(typeof message.title === "string") document.title = message.title;
          break;
        case "vibe:shortcut":
          if(message.key === "mod+k") onShortcut();
          break;
        case "vibe:hub": {
          // Only ever about the framed site, with this user's own rights on the hub.
          const hub = backend.hub;
          const id = message.id;
          try {
            if(!hub) throw new Error("This panel doesn't manage people");
            let result: unknown = null;
            if(message.call === "people") {
              const access = await hub.siteAccess(site.id);
              result = { people: access.people, roles: access.roles?.map(role => role.name) ?? [], canAssign: access.canAssign, assignable: access.assignable };
            } else if(message.call === "assign") {
              await hub.assign(site.id, message.who, message.roles);
            } else if(message.call === "unassign") {
              await hub.unassign(site.id, message.principal);
            }
            post({ type: "vibe:hubResult", id, ok: true, result });
          } catch (e) {
            post({ type: "vibe:hubResult", id, ok: false, error: (e as Error).message });
          }
          break;
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [site.id]);

  return (
    <div className="absolute inset-0">
      {showShell && <EditorShell dashboard={initialPath === "/" || initialPath === ""} />}
      {framed && <iframe key={attempt} ref={frame} src={src} title={`${site.name} editor`} className={cn("relative size-full border-0 bg-background transition-opacity duration-300 ease-out", revealed ? "opacity-100" : "opacity-0", state === "denied" && "invisible")} allow="clipboard-write" />}
      {state === "trouble" && (
        <div className="absolute inset-0 flex items-center justify-center bg-background p-6">
          <div className="rise-in flex max-w-sm flex-col items-center gap-3 text-center">
            <SiteMark site={site} className="size-12 rounded-[10px] text-base" />
            <h2 className="font-semibold">{site.name}</h2>
            <p className="text-sm text-muted-foreground">
              Having trouble connecting to {host}. {backend.mode === "local" ? "Check that its dev server is running" : "Check that the site is online"}; this page opens it as soon as it answers.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => go("/")}>Back to sites</Button>
              <Button variant="ghost" onClick={retry}>Try now</Button>
            </div>
          </div>
        </div>
      )}
      {(state === "denied" || state === "unreachable") && (
        <div className="absolute inset-0 flex items-center justify-center bg-background p-6">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <ShieldAlertIcon className="size-8 text-muted-foreground" />
            <h2 className="font-semibold">{state === "denied" ? "No access" : "Couldn't open this site"}</h2>
            <p className="text-sm text-muted-foreground">
              {state === "denied" ? `${site.name} doesn't give your account any role. Ask an administrator of the site to add you.` : error ?? "The site's editor didn't respond."}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => go("/")}>Back to sites</Button>
              {state === "unreachable" && <Button onClick={retry}>Try again</Button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Waits between checks of a site that isn't answering: about 30s in all before giving up. */
const CHECK_BACKOFF = [1_000, 2_000, 4_000, 8_000, 15_000];

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

export function startPanel(backend: PanelBackend, element: HTMLElement = document.getElementById("root")!) {
  startTheme();
  createRoot(element).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ErrorBoundary><Panel backend={backend} /></ErrorBoundary>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}
