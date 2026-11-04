import { keepPreviousData, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { navIcons } from "./icons.ts";
import type { IconName } from "../../icons.ts";
import { FileTextIcon, HomeIcon, ImageIcon, LanguagesIcon, LogOutIcon, MonitorIcon, Trash2Icon, MoonIcon, SunIcon, PlusIcon, SearchIcon, SlidersHorizontalIcon, AppWindowIcon, TriangleAlertIcon, UsersIcon, PlugIcon } from "lucide-react";
import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import Fuse from "fuse.js";
import type { AnyConfig } from "../../config.ts";
import { collectDescriptors, IMPL, loadLazy } from "../../descriptor.ts";
import type { AdminPlugin, AdminPluginFactory, AdminClient } from "../index.ts";
import { Button } from "../components/ui/button.tsx";
import { Command, CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "../components/ui/command.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
import { Kbd } from "../components/ui/kbd.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger
} from "../components/ui/sidebar.tsx";
import { Toaster } from "../components/ui/sonner.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { TipHost, TooltipProvider } from "../components/ui/tooltip.tsx";
import { createAdminClient, read, setUnauthorizedHandler, siteApi, type SessionState, type SiteInfo } from "./client.ts";
import { AdminContext, collectionLabel, collectionSettings, localeName, useAdmin, type AdminContextValue } from "./context.tsx";
import { ErrorBoundary } from "./error-boundary.tsx";
import { setAccent, setFavicon, startTheme, useTheme, type Theme } from "./theme.ts";
import { Delayed } from "./delayed.tsx";
import { MediaPage } from "./media.tsx";
import { Dashboard, DocumentRoute, ListPage, useDebounced } from "./pages.tsx";
import { Marked, markTitle } from "./marked.tsx";
import { SiteMark } from "../components/site-mark.tsx";
import { SiteSettingsPage } from "./settings.tsx";
import { SignIn } from "./signin.tsx";
import { UsersPage } from "./users.tsx";
import { ConnectApp, ConnectionsPage, takeConnectRequest } from "./connect.tsx";
import { TrashPage } from "./trash.tsx";
import { Link, match, navigate, ParamsContext, setBase, useLocation, useNavigationSync } from "./router.tsx";
import { closePreview, getPreview, onPreviewPick, setPreviewPrefix, showPreview, subscribePreview } from "./preview.ts";
import { openPick, type PreviewPick } from "./reveal.ts";
import { PreviewWindow } from "./preview-window.tsx";
import { embedded, getPanelAccent, postToPanel, renewSession, signOut, startSession, subscribePanelAccent } from "./session.ts";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } }
});

/** Collections and plugins name an icon from this set, or pass their own component. */
function Icon({ name, className }: { name?: IconName | ComponentType<{ className?: string }>, className?: string }) {
  if(typeof name === "function") {
    const Component = name;
    return <Component className={className} />;
  }
  const Component = (name && navIcons[name]) || FileTextIcon;
  return <Component className={className} />;
}

async function loadPlugins(config: AnyConfig, cms: AdminClient): Promise<Required<AdminPlugin>> {
  const merged: Required<AdminPlugin> = {
    widgets: {},
    pages: {},
    slots: { nav: [], "document.sidebar": [], "document.actions": [], "list.columns": [], "list.filters": [] },
    fieldDecorators: [],
    commands: []
  };
  const { plugins } = collectDescriptors(config);
  for(const plugin of plugins) {
    const admin = plugin[IMPL].admin;
    if(!admin) continue;
    try {
      const factory = await loadLazy(admin) as AdminPluginFactory;
      const result = factory({ cms });
      Object.assign(merged.widgets, result.widgets);
      for(const [path, page] of Object.entries(result.pages ?? {})) merged.pages[`/p/${plugin.name}${path}`] = page;
      for(const [slot, items] of Object.entries(result.slots ?? {})) {
        const list = merged.slots[slot as keyof typeof merged.slots] as unknown[];
        list.push(...(items as unknown[]).map(item => (slot === "nav" ? { ...(item as object), to: `/p/${plugin.name}${(item as { to: string }).to}` } : item)));
      }
      merged.fieldDecorators.push(...result.fieldDecorators ?? []);
      merged.commands.push(...result.commands ?? []);
    } catch (error) {
      console.error(`vibe-cms: admin entry for plugin "${plugin.name}" failed to load`, error);
    }
  }
  return merged;
}

function App({ config }: { config: AnyConfig }) {
  const prefix = useMemo(() => {
    const m = /^(.*)\/admin(\/|$)/.exec(location.pathname);
    return m?.[1] ?? config.prefix ?? "/_vibe";
  }, []);
  setBase(`${prefix}/admin`);
  const info = useQuery({ queryKey: ["info"], // The serialized schemas are JSON Schema, which `hc`'s JSON typing can't express; `SiteInfo` keeps them precise.
    queryFn: async () => await read(await siteApi(prefix).info.$get()) as unknown as SiteInfo, staleTime: Infinity });
  const [session, setSession] = useState<SessionState | null | undefined>(undefined);
  // An agent or the CLI asking to connect: shown once the user is signed in.
  const [connect, setConnect] = useState(takeConnectRequest);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if(!info.data) return;
    startSession(info.data).then(setSession, (e: Error) => {
      setError(e.message);
      setSession(null);
    });
    setUnauthorizedHandler(() => {
      renewSession(info.data!).then(next => setSession(next), () => setSession(null));
    });
  }, [info.data]);

  if(info.isError) return <Centered><p className="text-sm text-destructive">Couldn't reach the site's API: {(info.error as Error).message}</p></Centered>;
  if(!info.data || session === undefined) return <Delayed><Centered><Spinner className="size-5" /></Centered></Delayed>;
  if(!session) {
    return <SignIn info={info.data} error={error} onSignedIn={async () => {
      setError(null);
      setSession(await startSession(info.data!));
    }} />;
  }
  if(connect && !embedded) return <ConnectApp info={info.data} session={session} id={connect} onDone={() => setConnect(null)} />;
  return <Shell config={config} info={info.data} session={session} prefix={prefix} onSignOut={() => setSession(null)} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full items-center justify-center p-8">{children}</div>;
}

function Shell({ config, info, session, prefix, onSignOut }: {
  config: AnyConfig,
  info: SiteInfo,
  session: SessionState,
  prefix: string,
  onSignOut(): void
}) {
  const cms = useMemo(() => createAdminClient(prefix, Object.keys(config.schemas), path => navigate(path)), [prefix]);
  setPreviewPrefix(prefix);
  const [plugins, setPlugins] = useState<Required<AdminPlugin> | null>(null);
  const site = useQuery({ queryKey: ["site"], queryFn: () => cms.actions.site.get(), initialData: info.settings, staleTime: Infinity }).data;
  const panelAccent = useSyncExternalStore(subscribePanelAccent, getPanelAccent);

  useEffect(() => {
    setAccent(site.accent ?? panelAccent);
    setFavicon(site.icon?.url ?? site.favicon);
  }, [site.accent, site.icon?.url, site.favicon, panelAccent]);
  const { search } = useLocation();
  const locale = search.get("locale") && config.locales!.includes(search.get("locale")!) ? search.get("locale")! : config.defaultLocale!;

  useEffect(() => {
    void loadPlugins(config, cms).then(setPlugins);
  }, [config, cms]);

  function setLocale(next: string) {
    const params = new URLSearchParams(location.search);
    if(next === config.defaultLocale) params.delete("locale");
    else params.set("locale", next);
    const query = params.toString();
    const path = location.pathname.slice(`${prefix}/admin`.length) || "/";
    navigate(`${path}${query ? `?${query}` : ""}`, { replace: true });
  }

  if(!plugins) return <Delayed><Centered><Spinner className="size-5" /></Centered></Delayed>;
  const value: AdminContextValue = { config, info, site, session, cms, plugins, locale, setLocale };
  return (
    <AdminContext.Provider value={value}>
      <Layout onSignOut={onSignOut} />
    </AdminContext.Provider>
  );
}

function Layout({ onSignOut }: { onSignOut(): void }) {
  const { config, session, plugins, locale, setLocale, info, site, cms } = useAdmin();
  const { path } = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const previewOpen = useSyncExternalStore(subscribePreview, () => getPreview().open);
  useNavigationSync();

  // The preview's picker: a click there opens that block or field here.
  const readable = Object.keys(config.schemas).filter(t => session.permissions.types[t]?.read);
  useEffect(() => {
    onPreviewPick(pick => openPick(config, readable, path, pick as PreviewPick));
    return () => onPreviewPick(null);
  }, [config, path, readable.join()]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if(mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // Embedded, ⌘K belongs to the panel; ⌘J always opens the site's own palette.
        if(embedded) postToPanel({ type: "vibe:shortcut", key: "mod+k" });
        else setPaletteOpen(open => !open);
      }
      if(mod && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const types = Object.keys(config.schemas).filter(t => session.permissions.types[t]?.read);
  const singletons = types.filter(t => collectionSettings(config, t).singleton);
  const collections = types.filter(t => !collectionSettings(config, t).singleton);
  const canTrash = session.permissions.media.delete || types.some(t => session.permissions.types[t]?.delete);
  // Sites in an org leave who may sign in to the hub; in development nobody signs in for real.
  const canManageUsers = session.permissions.users && info.signIn !== "hub" && !info.dev;
  // Agents and the CLI connect to the site itself only when it signs people in itself.
  const canConnect = info.signIn !== "hub" && !info.dev;

  let page: React.ReactNode = null;
  let params: Record<string, string> | null;
  if(path === "/") page = <Dashboard />;
  else if((params = match("/content/:type", path)) && types.includes(params.type!)) page = <ListPage key={params.type} type={params.type!} />;
  else if((params = match("/content/:type/:id", path)) && types.includes(params.type!)) page = <DocumentRoute type={params.type!} id={params.id!} />;
  else if(path === "/media" && session.permissions.media.read) page = <MediaPage />;
  else if(path === "/settings" && session.permissions.site) page = <SiteSettingsPage />;
  else if(path === "/users" && canManageUsers) page = <UsersPage />;
  else if(path === "/connections" && canConnect) page = <ConnectionsPage />;
  else if(path === "/trash" && canTrash) page = <TrashPage />;
  else {
    for(const [pattern, entry] of Object.entries(plugins.pages)) {
      const found = match(pattern, path);
      if(found) {
        const Page = entry.component;
        page = <ParamsContext.Provider value={found}><PluginPage><Page cms={cms} params={found} /></PluginPage></ParamsContext.Provider>;
        break;
      }
    }
  }
  page ??= (
    <Centered>
      <div className="text-center">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <Link to="/" className="text-sm text-muted-foreground underline">Go to the dashboard</Link>
      </div>
    </Centered>
  );

  function active(to: string) {
    return to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`);
  }

  return (
    <SidebarProvider className="h-full min-h-0 bg-sidebar">
      <Sidebar collapsible="icon" variant="inset" className="[&_[data-slot=sidebar-inner]]:bg-transparent">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link to="/" />} tooltip={site.name}>
                <SiteMark name={site.name} icon={site.icon?.url ?? site.favicon} className="size-8 rounded-[10px] text-sm" />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">{site.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{location.host}</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          {/* Opens the palette; styled as a field so it doesn't read as a page. */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search"
            className="mt-1 flex h-9 w-full items-center gap-2 rounded-[10px] well pr-1.5 pl-2.5 text-sm text-muted-foreground transition-colors hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          >
            <SearchIcon className="size-4 shrink-0" />
            <span className="flex-1 text-left group-data-[collapsible=icon]:hidden">Search…</span>
            <Kbd className="h-6 rounded-[4px] px-1.5 group-data-[collapsible=icon]:hidden">⌘J</Kbd>
          </button>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <NavButton active={active("/")} to="/" tooltip="Dashboard"><HomeIcon /> <span>Dashboard</span></NavButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Preview" isActive={previewOpen} aria-pressed={previewOpen} onClick={() => (previewOpen ? closePreview() : void showPreview(cms))}>
                    <AppWindowIcon /> <span>Preview</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel className="eyebrow">Content</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {collections.map(type => (
                  <SidebarMenuItem key={type}>
                    <NavButton active={active(`/content/${type}`)} to={`/content/${type}${locale !== config.defaultLocale ? `?locale=${locale}` : ""}`} tooltip={collectionLabel(config, type)}>
                      <Icon name={collectionSettings(config, type).icon ?? "file-text"} />
                      <span>{collectionLabel(config, type)}</span>
                    </NavButton>
                  </SidebarMenuItem>
                ))}
                {session.permissions.media.read && (
                  <SidebarMenuItem>
                    <NavButton active={active("/media")} to="/media" tooltip="Media"><ImageIcon /> <span>Media</span></NavButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {(singletons.length > 0 || session.permissions.site || canManageUsers) && (
            <SidebarGroup>
              <SidebarGroupLabel className="eyebrow">Settings</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {session.permissions.site && (
                    <SidebarMenuItem>
                      <NavButton active={active("/settings")} to="/settings" tooltip="Site"><SlidersHorizontalIcon /> <span>Site</span></NavButton>
                    </SidebarMenuItem>
                  )}
                  {canManageUsers && (
                    <SidebarMenuItem>
                      <NavButton active={active("/users")} to="/users" tooltip="Users"><UsersIcon /> <span>Users</span></NavButton>
                    </SidebarMenuItem>
                  )}
                  {singletons.map(type => (
                    <SidebarMenuItem key={type}>
                      <NavButton active={active(`/content/${type}`)} to={`/content/${type}`} tooltip={collectionLabel(config, type)}>
                        <Icon name={collectionSettings(config, type).icon ?? "settings"} />
                        <span>{collectionLabel(config, type)}</span>
                      </NavButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          {plugins.slots.nav!.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel className="eyebrow">Tools</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {plugins.slots.nav!.map(item => (
                    <SidebarMenuItem key={item.to}>
                      <NavButton active={active(item.to)} to={item.to} tooltip={item.label}>
                        <Icon name={item.icon} /> <span>{item.label}</span>
                      </NavButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          {/* Apart from the content types, at the bottom, so it doesn't read as one of them. */}
          {canTrash && (
            <SidebarGroup className="mt-auto">
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <NavButton active={active("/trash")} to="/trash" tooltip="Trash"><Trash2Icon /> <span>Trash</span></NavButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter>
          {/* In the sidebar rather than floating over the page, where it covered bottom-anchored controls. */}
          {info.dev && !embedded && (
            <p className="px-2 text-[11px] leading-snug text-muted-foreground group-data-[collapsible=icon]:hidden" title="Signed in without an identity provider">
              Development mode: signed in without an identity provider
            </p>
          )}
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger render={
                  <SidebarMenuButton size="lg" tooltip={session.user.name ?? session.user.email ?? "Account"}>
                    <div className="flex size-8 items-center justify-center rounded-full bg-sidebar-accent text-xs font-medium">
                      {(session.user.name ?? session.user.email ?? "?").charAt(0).toUpperCase()}
                    </div>
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate text-sm font-medium">{session.user.name ?? session.user.email}</span>
                      <span className="truncate text-xs text-muted-foreground">{session.user.roles.join(", ") || "No roles"}</span>
                    </div>
                  </SidebarMenuButton>
                } />
                <DropdownMenuContent side="top" align="start" className="w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="truncate">{session.user.email ?? session.user.sub}</DropdownMenuLabel>
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
                  {canConnect && (
                    <DropdownMenuItem onClick={() => navigate("/connections")}><PlugIcon /> Connected apps</DropdownMenuItem>
                  )}
                  {!embedded && !info.dev && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={async () => {
                        await signOut(info.prefix);
                        onSignOut();
                      }}><LogOutIcon /> Sign out</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      {/* Flush with the window's right edge (no margin, square corners there) so the scrollbar runs along it instead of over a rounded corner. */}
      <SidebarInset data-scroll-root className="relative z-10 min-h-0 overflow-y-auto md:peer-data-[variant=inset]:mr-0 md:peer-data-[variant=inset]:rounded-l-[20px] md:peer-data-[variant=inset]:rounded-r-none md:peer-data-[variant=inset]:shadow-(--shadow-card)">
        <div className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
          <SidebarTrigger />
        </div>
        {/* Sticky inside the scrolling panel rather than fixed to the window, so it stays clear of the scrollbar, whatever its width. */}
        {config.locales!.length > 1 && (
          <div className="pointer-events-none sticky top-0 z-30 hidden h-0 justify-end md:flex">
            <div className="pointer-events-auto mt-2.5 mr-2.5">
              <LocaleMenu locale={locale} setLocale={setLocale} />
            </div>
          </div>
        )}
        <OrgMoveBanner />
        <div className="min-h-full" data-page>
          <ErrorBoundary resetKey={path}>{page}</ErrorBoundary>
        </div>
      </SidebarInset>
      <ErrorBoundary resetKey={paletteOpen}><Palette open={paletteOpen} onOpenChange={setPaletteOpen} /></ErrorBoundary>
      <ErrorBoundary resetKey={previewOpen}><PreviewWindow /></ErrorBoundary>
      <TipHost />
      <Toaster position="bottom-right" />
    </SidebarProvider>
  );
}

/**
 * A move to another org, announced for its whole waiting period. A real rename can wait; a move nobody
 * asked for gets noticed and cancelled before the site starts trusting another hub.
 */
function OrgMoveBanner() {
  const { info, session, config } = useAdmin();
  const [move, setMove] = useState(info.site.orgMove);
  const [busy, setBusy] = useState(false);
  if(!move) return null;
  const when = new Date(move.effectiveAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  // The language menu floats over the top right corner.
  const clearLocaleMenu = config.locales!.length > 1 ? "md:pr-36" : "";
  return (
    <div role="alert" className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm ${clearLocaleMenu}`}>
      <TriangleAlertIcon className="size-4 shrink-0 text-amber-600" />
      <p className="min-w-0 flex-1">
        This site is moving from <strong className="font-medium">{info.site.org}</strong> to <strong className="font-medium">{move.to}</strong> on {when}.
        {" "}{session.permissions.site ? "If nobody in your organization asked for this, cancel it." : "If you didn't expect this, tell someone who manages this site."}
      </p>
      {session.permissions.site && (
        <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            await read(await siteApi(info.prefix).org.move.$delete());
            setMove(null);
          } finally {
            setBusy(false);
          }
        }}>Cancel move</Button>
      )}
    </div>
  );
}

function LocaleMenu({ locale, setLocale }: { locale: string, setLocale(locale: string): void }) {
  const { config } = useAdmin();
  const { path } = useLocation();
  // The editor header has its own language tabs.
  if(match("/content/:type/:id", path)) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8 rounded-[10px]"><LanguagesIcon /> {localeName(locale)}</Button>} />
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={locale} onValueChange={next => setLocale(next as string)}>
          {config.locales!.map(l => <DropdownMenuRadioItem key={l} value={l}>{localeName(l)}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A sidebar link. The active item is a raised tile with an accent-coloured icon; hover is only a faint tint. */
function NavButton({ to, active, tooltip, children }: { to: string, active: boolean, tooltip: string, children: React.ReactNode }) {
  return (
    <SidebarMenuButton
      isActive={active}
      tooltip={tooltip}
      className="rounded-[10px] transition-[background-color,box-shadow,color,scale] duration-150 ease-out active:scale-[0.98] data-active:raised data-active:font-medium data-active:[&_svg]:text-brand"
      render={<Link to={to} />}
    >
      {children}
    </SidebarMenuButton>
  );
}

function PluginPage({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">{children}</div>;
}

interface PaletteCommand {
  id: string,
  group: "Go to" | "Site" | "Create" | "Commands",
  label: string,
  icon?: ReactNode,
  run(): void
}

function Palette({ open, onOpenChange }: { open: boolean, onOpenChange(open: boolean): void }) {
  const { config, session, plugins, cms, locale } = useAdmin();
  const [search, setSearch] = useState("");
  const types = Object.keys(config.schemas).filter(t => session.permissions.types[t]?.read);
  const query = search.trim();
  const debounced = useDebounced(query, 120);
  // Ranked on the server (SQLite FTS5); the previous results stay up while the next ones load.
  const found = useQuery({
    queryKey: ["palette", locale, debounced],
    enabled: open && debounced.length > 0,
    queryFn: () => cms.actions.documents.search({ query: debounced, locale, limit: 12 }),
    placeholderData: keepPreviousData,
    staleTime: 10_000
  });
  useEffect(() => {
    if(!open) setSearch("");
  }, [open]);
  function go(to: string) {
    onOpenChange(false);
    navigate(to);
  }
  const commands: PaletteCommand[] = [
    { id: "dashboard", group: "Go to", label: "Dashboard", icon: <HomeIcon />, run: () => go("/") },
    ...types.map((type): PaletteCommand => ({ id: `go-${type}`, group: "Go to", label: collectionLabel(config, type), icon: <Icon name={collectionSettings(config, type).icon} />, run: () => go(`/content/${type}`) })),
    ...(session.permissions.media.read ? [{ id: "media", group: "Go to", label: "Media", icon: <ImageIcon />, run: () => go("/media") } satisfies PaletteCommand] : []),
    ...(session.permissions.media.delete || types.some(t => session.permissions.types[t]?.delete) ? [{ id: "trash", group: "Go to", label: "Trash", icon: <Trash2Icon />, run: () => go("/trash") } satisfies PaletteCommand] : []),
    { id: "preview", group: "Site", label: "Preview drafts", icon: <AppWindowIcon />, run: () => {
      onOpenChange(false);
      void showPreview(cms);
    } },
    ...types.filter(t => session.permissions.types[t]?.write && !collectionSettings(config, t).singleton).map((type): PaletteCommand => ({
      id: `new-${type}`, group: "Create", label: `New ${collectionLabel(config, type, false).toLowerCase()}`, icon: <PlusIcon />, run: () => go(`/content/${type}/new`)
    })),
    ...plugins.commands.map((command): PaletteCommand => ({ id: `command-${command.id}`, group: "Commands", label: command.label, run: async () => {
      onOpenChange(false);
      try {
        await command.run();
      } catch (error) {
        cms.toast((error as Error).message, { type: "error" });
      }
    } }))
  ];
  const matchedCommands = query ? new Fuse(commands, { keys: ["label"], threshold: 0.3, ignoreLocation: true }).search(query).map(r => r.item) : commands;
  const documents = query ? found.data?.results ?? [] : [];
  const searching = query.length > 0 && (query !== debounced || found.isFetching);
  const groups = query
    ? [matchedCommands.filter(c => c.group === "Go to"), "documents", matchedCommands.filter(c => c.group !== "Go to")] as const
    : (["Go to", "Site", "Create", "Commands"] as const).map(group => commands.filter(c => c.group === group));
  const nothing = query && !searching && !documents.length && !matchedCommands.length;
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      {/* shadcn's CommandDialog doesn't provide the cmdk context itself. Ranking is ours, so cmdk only keeps the order. */}
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search documents or jump to…" value={search} onValueChange={setSearch} />
        <CommandList>
          {nothing && <div className="py-6 text-center text-sm text-muted-foreground">{found.isError ? "Search isn’t available right now." : `No results for “${query}”.`}</div>}
          {groups.map((group, i) => {
            if(group === "documents") {
              return (documents.length > 0 || searching) && (
                <CommandGroup key="documents" heading={<span className="flex items-center gap-2">Documents {searching && <Spinner className="size-3" />}</span>}>
                  {documents.map(doc => (
                    <CommandItem key={`${doc.type}/${doc.id}`} value={`doc-${doc.type}-${doc.id}`} onSelect={() => go(`/content/${doc.type}/${doc.id}`)}>
                      <FileTextIcon className={doc.excerpt ? "mt-0.5 self-start" : undefined} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate"><Marked text={doc.title ? markTitle(doc.title, debounced) : "Untitled"} /></span>
                        {doc.excerpt && <span className="truncate text-xs text-muted-foreground"><Marked text={doc.excerpt} /></span>}
                      </span>
                      <CommandShortcut className={doc.excerpt ? "self-start" : undefined}>{collectionLabel(config, doc.type, false)}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            }
            return group.length > 0 && (
              <CommandGroup key={i} heading={query && group[0]!.group !== "Go to" ? "Actions" : group[0]!.group}>
                {group.map(command => (
                  <CommandItem key={command.id} value={command.id} onSelect={command.run}>{command.icon} {command.label}</CommandItem>
                ))}
              </CommandGroup>
            );
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

/** Boots the site's editor. Called by the build's generated entry with the site's config. */
export function startAdmin(config: AnyConfig, element: HTMLElement = document.getElementById("root")!) {
  startTheme();
  createRoot(element).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ErrorBoundary><App config={config} /></ErrorBoundary>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}
