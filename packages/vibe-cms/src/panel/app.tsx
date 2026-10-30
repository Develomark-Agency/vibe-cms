import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronsUpDownIcon,
  ExternalLinkIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ShieldAlertIcon,
  StarIcon,
  Trash2Icon
} from "lucide-react";
import { StrictMode, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Button } from "../admin/components/ui/button.tsx";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Command } from "../admin/components/ui/command.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../admin/components/ui/dialog.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../admin/components/ui/dropdown-menu.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../admin/components/ui/empty.tsx";
import { Input } from "../admin/components/ui/input.tsx";
import { Kbd } from "../admin/components/ui/kbd.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../admin/components/ui/popover.tsx";
import { Toaster } from "../admin/components/ui/sonner.tsx";
import { Spinner } from "../admin/components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../admin/components/ui/tooltip.tsx";
import { cn } from "../admin/lib/utils.ts";
import { ErrorBoundary } from "../admin/app/error-boundary.tsx";
import { setDark } from "../admin/app/theme.ts";
import { Delayed } from "../admin/app/delayed.tsx";
import { ShaderBackdrop } from "../admin/app/texture.tsx";
import { PanelError, type PanelBackend, type PanelSite } from "./backend.ts";

type EditorMessage =
  | { type: "vibe:ready", protocol: number }
  | { type: "vibe:needCode" }
  | { type: "vibe:navigated", path: string }
  | { type: "vibe:title", title: string }
  | { type: "vibe:shortcut", key: string };

// --- Location ---------------------------------------------------------------------

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

function go(path: string) {
  history.pushState(null, "", path);
  listeners.forEach(l => l());
}

function useRoute(): { siteId: string | null, rest: string } {
  const path = useSyncExternalStore(subscribe, () => location.pathname + location.search);
  const match = /^\/s\/([^/?]+)(.*)$/.exec(path);
  return match ? { siteId: decodeURIComponent(match[1]!), rest: match[2] || "/" } : { siteId: null, rest: "/" };
}

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

function sortSites(sites: PanelSite[]): PanelSite[] {
  return [...sites].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
}

function initials(name: string) {
  return name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function SiteMark({ site, className }: { site: PanelSite, className?: string }) {
  let hue = 0;
  for(const char of site.id) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return (
    <span
      className={cn("flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white", className)}
      style={{ background: `oklch(0.55 0.15 ${hue})` }}
    >
      {initials(site.name)}
    </span>
  );
}

// --- App ----------------------------------------------------------------------------

function Panel({ backend }: { backend: PanelBackend }) {
  const me = useQuery({ queryKey: ["me"], queryFn: () => backend.me(), retry: false });
  if(me.isLoading) return <Delayed><div className="flex h-full items-center justify-center"><Spinner className="size-5" /></div></Delayed>;
  if(me.isError) return <div className="flex h-full items-center justify-center text-sm text-destructive">{(me.error as Error).message}</div>;
  if(!me.data) return <SignIn backend={backend} />;
  return <Shell backend={backend} user={me.data} />;
}

function SignIn({ backend }: { backend: PanelBackend }) {
  const error = new URLSearchParams(location.search).get("error");
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden p-6">
      <ShaderBackdrop variant="aurora" />
      <div className="relative z-10 flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border bg-background/80 px-8 py-10 text-center shadow-[0_24px_60px_-30px_rgb(0_0_0/0.45)] backdrop-blur-md">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-brand text-brand-foreground shadow-sm">
          <KeyRoundIcon className="size-5" />
        </div>
        <div className="space-y-2">
          <p className="eyebrow">Panel</p>
          <h1 className="text-xl font-medium tracking-tight">Sign in to your sites</h1>
          <p className="text-sm text-muted-foreground">One sign-in for every site your agency manages.</p>
        </div>
        {error && <p className="w-full rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <Button size="lg" className="w-full" render={<a href={`${backend.signInUrl}?return=${encodeURIComponent(location.pathname)}`} />} nativeButton={false}>
          Continue with your identity provider
        </Button>
      </div>
    </div>
  );
}

function Shell({ backend, user }: { backend: PanelBackend, user: { name?: string, email?: string } }) {
  const queryClient = useQueryClient();
  const { siteId, rest } = useRoute();
  const [addOpen, setAddOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  useCloseOnFrameFocus(accountOpen, () => setAccountOpen(false));
  useCloseOnFrameFocus(paletteOpen, () => setPaletteOpen(false));
  const sites = useQuery({ queryKey: ["sites"], queryFn: () => backend.sites() });
  const site = sites.data?.find(s => s.id === siteId) ?? null;

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
    if(!site) document.title = "Sites";
  }, [site]);

  function openExternally(target: PanelSite) {
    window.open(backend.mode === "hosted" ? `/go/${encodeURIComponent(target.id)}` : `${target.admin}/`, "_blank", "noopener");
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
        <button onClick={() => go("/")} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-semibold tracking-tight hover:bg-sidebar-accent">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-[11px] text-primary-foreground">v</span>
          <span className="hidden sm:inline">vibe</span>
        </button>
        <span className="text-muted-foreground/40">/</span>
        <SiteSwitcher sites={sites.data ?? []} current={site} onAdd={() => setAddOpen(true)} />
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
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Open in new tab" onClick={() => openExternally(site)}><ExternalLinkIcon /></Button>} />
              <TooltipContent>Open the editor in a new tab</TooltipContent>
            </Tooltip>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" className="hidden text-muted-foreground sm:flex" onClick={() => setPaletteOpen(true)}>
            Jump to… <Kbd>⌘K</Kbd>
          </Button>
          {backend.mode === "local" && <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">Local</span>}
          <DropdownMenu open={accountOpen} onOpenChange={setAccountOpen}>
            <DropdownMenuTrigger render={
              <Button variant="ghost" size="icon-sm" aria-label="Account" className="rounded-full bg-muted text-xs font-medium">
                {(user.name ?? user.email ?? "?").charAt(0).toUpperCase()}
              </Button>
            } />
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate">{user.email ?? user.name}</DropdownMenuLabel>
              </DropdownMenuGroup>
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
        {siteId === null ? (
          <SiteList backend={backend} sites={sites.data} loading={sites.isLoading} onAdd={() => setAddOpen(true)} onOpenExternally={openExternally} />
        ) : site ? (
          <SiteFrame key={site.id} backend={backend} site={site} initialPath={rest} onShortcut={() => setPaletteOpen(true)} />
        ) : sites.isLoading ? (
          <Delayed><div className="flex h-full items-center justify-center"><Spinner /></div></Delayed>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">This site isn't in the list.</div>
        )}
      </main>
      <AddSiteDialog backend={backend} open={addOpen} onOpenChange={setAddOpen} />
      <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <Command>
          <CommandInput placeholder="Switch to a site…" />
          <CommandList>
            <CommandEmpty>No sites found.</CommandEmpty>
            <CommandGroup heading="Sites">
              {sortSites(sites.data ?? []).map(s => (
                <CommandItem key={s.id} value={`${s.name} ${s.url}`} onSelect={() => {
                  setPaletteOpen(false);
                  go(`/s/${encodeURIComponent(s.id)}/`);
                }}>
                  <SiteMark site={s} className="size-5" />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {s.favorite && <StarIcon className="fill-amber-400 text-amber-400" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Panel">
              <CommandItem onSelect={() => {
                setPaletteOpen(false);
                go("/");
              }}><LayoutGridIcon /> All sites</CommandItem>
              <CommandItem onSelect={() => {
                setPaletteOpen(false);
                setAddOpen(true);
              }}><PlusIcon /> Add a site</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
      <Toaster position="bottom-right" />
    </div>
  );
}

function SiteSwitcher({ sites, current, onAdd }: { sites: PanelSite[], current: PanelSite | null, onAdd(): void }) {
  const [open, setOpen] = useState(false);
  useCloseOnFrameFocus(open, () => setOpen(false));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={
        <Button variant="ghost" size="sm" className="max-w-72 gap-2 px-1.5 font-medium">
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
                  <span className="min-w-0 flex-1 truncate">{site.name}</span>
                  {site.favorite && <StarIcon className="fill-amber-400 text-amber-400" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup>
              <CommandItem onSelect={() => {
                setOpen(false);
                go("/");
              }}><LayoutGridIcon /> All sites</CommandItem>
              <CommandItem onSelect={() => {
                setOpen(false);
                onAdd();
              }}><PlusIcon /> Add a site…</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SiteList({ backend, sites, loading, onAdd, onOpenExternally }: {
  backend: PanelBackend,
  sites: PanelSite[] | undefined,
  loading: boolean,
  onAdd(): void,
  onOpenExternally(site: PanelSite): void
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  if(loading) return <Delayed><div className="flex h-full items-center justify-center"><Spinner /></div></Delayed>;
  const list = sortSites(sites ?? []).filter(s => `${s.name} ${s.url}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="h-full overflow-y-auto">
      <section className="relative overflow-hidden border-b">
        <ShaderBackdrop />
        <div className="relative z-10 mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-3 px-4 pt-16 pb-8 md:px-8">
          <div className="space-y-2">
            <p className="eyebrow">{backend.mode === "hosted" ? "Agency" : "Local"} · {sites?.length ?? 0} {sites?.length === 1 ? "site" : "sites"}</p>
            <h1 className="text-3xl font-medium tracking-[-0.03em]">Sites</h1>
            <p className="text-sm text-muted-foreground">
              {backend.mode === "hosted" ? "Shared with everyone using this panel. Access to each site is decided by the site." : "Development sites on this machine."}
            </p>
          </div>
          <div className="flex gap-2">
            {(sites?.length ?? 0) > 6 && <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter" className="w-48 bg-background/70 backdrop-blur" />}
            <Button onClick={onAdd}><PlusIcon /> Add site</Button>
          </div>
        </div>
      </section>
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 md:px-8">
        {sites?.length === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon"><GlobeIcon /></EmptyMedia>
              <EmptyTitle>No sites yet</EmptyTitle>
              <EmptyDescription>Add a site by its URL. It needs vibe-cms and has to trust the same identity provider as this panel.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent><Button onClick={onAdd}><PlusIcon /> Add your first site</Button></EmptyContent>
          </Empty>
        ) : (
          <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((site, i) => (
              <div key={site.id} style={{ "--i": i } as CSSProperties} className="group/card relative flex items-center gap-3 rounded-xl border bg-card p-4 transition-[box-shadow,translate,border-color] duration-200 hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-md">
                <SiteMark site={site} className="size-10 rounded-lg text-sm" />
                <button className="min-w-0 flex-1 text-left after:absolute after:inset-0" onClick={() => go(`/s/${encodeURIComponent(site.id)}/`)}>
                  <span className="block truncate font-medium">{site.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{new URL(site.url).host}</span>
                </button>
                <div className="relative z-10 flex items-center">
                  <Button variant="ghost" size="icon-sm" aria-label={site.favorite ? "Unfavorite" : "Favorite"} onClick={async () => {
                    await backend.setFavorite(site.id, !site.favorite);
                    void queryClient.invalidateQueries({ queryKey: ["sites"] });
                  }}>
                    <StarIcon className={cn(site.favorite ? "fill-amber-400 text-amber-400" : "opacity-0 group-hover/card:opacity-100")} />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Site actions"><MoreHorizontalIcon /></Button>} />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onOpenExternally(site)}><ExternalLinkIcon /> Open in new tab</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => window.open(site.url, "_blank", "noopener")}><GlobeIcon /> Visit site</DropdownMenuItem>
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AddSiteDialog({ backend, open, onOpenChange }: { backend: PanelBackend, open: boolean, onOpenChange(open: boolean): void }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const add = useMutation({
    mutationFn: () => backend.addSite(url.trim()),
    onSuccess: site => {
      void queryClient.invalidateQueries({ queryKey: ["sites"] });
      onOpenChange(false);
      setUrl("");
      toast.success(`Added ${site.name}`);
      go(`/s/${encodeURIComponent(site.id)}/`);
    }
  });
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
              Paste the site's address. The panel reads its <code className="text-xs">/.well-known/vibe-cms</code> and checks that it trusts this panel's identity provider.
            </DialogDescription>
          </DialogHeader>
          <Input autoFocus value={url} onChange={e => setUrl(e.target.value)} placeholder="https://client-site.com" aria-label="Site URL" />
          {add.isError && <p className="text-sm text-destructive">{(add.error as Error).message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!url.trim() || add.isPending}>{add.isPending && <Spinner />} Add site</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Frames one site's editor and speaks the panel ↔ editor protocol with it. */
function SiteFrame({ backend, site, initialPath, onShortcut }: { backend: PanelBackend, site: PanelSite, initialPath: string, onShortcut(): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = new URL(site.admin).origin;
  const [state, setState] = useState<"loading" | "ready" | "denied" | "unreachable">("loading");
  const [error, setError] = useState<string | null>(null);
  // The src is fixed per site; later navigation happens inside the editor and is mirrored here.
  const src = useMemo(() => `${site.admin}${initialPath.startsWith("/") ? initialPath : `/${initialPath}`}`, [site.id]);

  useEffect(() => {
    const timeout = setTimeout(() => setState(s => (s === "loading" ? "unreachable" : s)), 20_000);
    async function onMessage(event: MessageEvent) {
      if(event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data as EditorMessage;
      switch(message?.type) {
        case "vibe:ready":
          clearTimeout(timeout);
          setState("ready");
          break;
        case "vibe:needCode":
          try {
            // Codes are only ever minted for, and sent to, the framed site.
            const code = await backend.codeFor(site.id);
            if(code) frame.current?.contentWindow?.postMessage({ type: "vibe:code", code }, origin);
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
      }
    }
    window.addEventListener("message", onMessage);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
  }, [site.id]);

  return (
    <div className="absolute inset-0">
      <iframe ref={frame} src={src} title={`${site.name} editor`} className={cn("size-full border-0 bg-background transition-opacity duration-300 ease-out", state === "ready" ? "opacity-100" : "opacity-0", state === "denied" && "invisible")} allow="clipboard-write" />
      {state === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background"><Delayed><Spinner className="size-5" /></Delayed></div>
      )}
      {(state === "denied" || state === "unreachable") && (
        <div className="absolute inset-0 flex items-center justify-center bg-background p-6">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <ShieldAlertIcon className="size-8 text-muted-foreground" />
            <h2 className="font-semibold">{state === "denied" ? "No access" : "Couldn't open this site"}</h2>
            <p className="text-sm text-muted-foreground">
              {state === "denied" ? `${site.name} doesn't give your account any role. Ask an administrator of the site to add you.` : error ?? "The site's editor didn't respond."}
            </p>
            <Button variant="outline" onClick={() => go("/")}>Back to sites</Button>
          </div>
        </div>
      )}
    </div>
  );
}

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

function applyTheme() {
  const media = matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    setDark(media.matches);
  }
  apply();
  media.addEventListener("change", apply);
}

export function startPanel(backend: PanelBackend, element: HTMLElement = document.getElementById("root")!) {
  applyTheme();
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
