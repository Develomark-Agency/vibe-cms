import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { navIcons } from "./icons.ts";
import type { IconName } from "../../icons.ts";
import { FileTextIcon, HomeIcon, ImageIcon, LanguagesIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon, PlusIcon, SearchIcon, KeyRoundIcon, SlidersHorizontalIcon } from "lucide-react";
import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { AnyConfig } from "../../config.ts";
import { collectDescriptors, IMPL, loadLazy } from "../../descriptor.ts";
import type { AdminPlugin, AdminPluginFactory, AdminClient } from "../index.ts";
import { Button } from "../components/ui/button.tsx";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "../components/ui/command.tsx";
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
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { createAdminClient, request, setUnauthorizedHandler, type SessionState, type SiteInfo } from "./client.ts";
import { AdminContext, collectionLabel, collectionSettings, documentTitle, localeName, useAdmin, type AdminContextValue } from "./context.tsx";
import { ErrorBoundary } from "./error-boundary.tsx";
import { setAccent, setFavicon, startTheme, useTheme, type Theme } from "./theme.ts";
import { Delayed } from "./delayed.tsx";
import { MediaPage } from "./media.tsx";
import { Dashboard, DocumentRoute, ListPage } from "./pages.tsx";
import { SiteMark, SiteSettingsPage } from "./settings.tsx";
import { Link, match, navigate, ParamsContext, setBase, useLocation, useNavigationSync } from "./router.tsx";
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
  const info = useQuery({ queryKey: ["info"], queryFn: () => request<SiteInfo>(prefix, "/info"), staleTime: Infinity });
  const [session, setSession] = useState<SessionState | null | undefined>(undefined);
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
  if(!session) return <SignIn info={info.data} error={error} />;
  return <Shell config={config} info={info.data} session={session} prefix={prefix} onSignOut={() => setSession(null)} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full items-center justify-center p-8">{children}</div>;
}

function SignIn({ info, error }: { info: SiteInfo, error: string | null }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-sidebar p-8">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-[24px] elevated px-8 py-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-[14px] raised-brand">
          <KeyRoundIcon className="size-5" />
        </div>
        <div className="space-y-2">
          <p className="eyebrow">Editor</p>
          <h1 className="text-xl font-medium tracking-tight">{info.site.name}</h1>
          <p className="text-sm text-balance text-muted-foreground">
            {embedded
              ? "Waiting for your agency panel to sign you in…"
              : "Open this editor from your agency's panel to sign in. Sessions are handed over from the panel; this page has no password form."}
          </p>
          {info.auth && <p className="text-xs text-muted-foreground">{new URL(info.auth.issuer).host}</p>}
        </div>
        {error && <p className="rounded-[12px] bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}

function Shell({ config, info, session, prefix, onSignOut }: {
  config: AnyConfig,
  info: SiteInfo,
  session: SessionState,
  prefix: string,
  onSignOut(): void
}) {
  const cms = useMemo(() => createAdminClient(prefix, Object.keys(config.schemas), path => navigate(path)), [prefix]);
  const [plugins, setPlugins] = useState<Required<AdminPlugin> | null>(null);
  const site = useQuery({ queryKey: ["site"], queryFn: () => cms.api<SiteInfo["settings"]>("/site"), initialData: info.settings, staleTime: Infinity }).data;
  const panelAccent = useSyncExternalStore(subscribePanelAccent, getPanelAccent);

  useEffect(() => {
    setAccent(site.accent ?? panelAccent);
    setFavicon(site.icon?.url ?? null);
  }, [site.accent, site.icon?.url, panelAccent]);
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
  useNavigationSync();

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

  let page: React.ReactNode = null;
  let params: Record<string, string> | null;
  if(path === "/") page = <Dashboard />;
  else if((params = match("/content/:type", path)) && types.includes(params.type!)) page = <ListPage key={params.type} type={params.type!} />;
  else if((params = match("/content/:type/:id", path)) && types.includes(params.type!)) page = <DocumentRoute type={params.type!} id={params.id!} />;
  else if(path === "/media" && session.permissions.media.read) page = <MediaPage />;
  else if(path === "/settings" && session.permissions.site) page = <SiteSettingsPage />;
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
                <SiteMark site={site} className="size-8 rounded-[10px] text-sm" />
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
          {(singletons.length > 0 || session.permissions.site) && (
            <SidebarGroup>
              <SidebarGroupLabel className="eyebrow">Settings</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {session.permissions.site && (
                    <SidebarMenuItem>
                      <NavButton active={active("/settings")} to="/settings" tooltip="Site"><SlidersHorizontalIcon /> <span>Site</span></NavButton>
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
        </SidebarContent>
        <SidebarFooter>
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
      <SidebarInset className="relative z-10 min-h-0 overflow-y-auto md:peer-data-[variant=inset]:rounded-[20px] md:peer-data-[variant=inset]:shadow-(--shadow-card)">
        <div className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
          <SidebarTrigger />
        </div>
        {/* 10px in from the panel's 20px corner (its margin is 8px), so the 10px button corner sits concentric. */}
        <div className="pointer-events-none fixed top-[18px] right-[18px] z-30 hidden md:block">
          {config.locales!.length > 1 && (
            <div className="pointer-events-auto">
              <LocaleMenu locale={locale} setLocale={setLocale} />
            </div>
          )}
        </div>
        <div className="min-h-full" style={{ viewTransitionName: "page" }}>
          <ErrorBoundary resetKey={path}>{page}</ErrorBoundary>
        </div>
      </SidebarInset>
      <ErrorBoundary resetKey={paletteOpen}><Palette open={paletteOpen} onOpenChange={setPaletteOpen} /></ErrorBoundary>
      <Toaster position="bottom-right" />
      {info.dev && !embedded && (
        <div className="pointer-events-none fixed bottom-3 left-1/2 z-40 -translate-x-1/2 rounded-full border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
          Development mode: signed in without an identity provider
        </div>
      )}
    </SidebarProvider>
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

function Palette({ open, onOpenChange }: { open: boolean, onOpenChange(open: boolean): void }) {
  const { config, session, plugins, cms } = useAdmin();
  const [search, setSearch] = useState("");
  const types = Object.keys(config.schemas).filter(t => session.permissions.types[t]?.read);
  const results = useQuery({
    queryKey: ["palette", search],
    enabled: open && search.length > 1,
    queryFn: async () => (await Promise.all(types.map(async type => {
      const { docs } = await cms.documents.list(type, { search, limit: 5 });
      return docs.map(doc => ({ type, doc }));
    }))).flat()
  });
  function go(to: string) {
    onOpenChange(false);
    navigate(to);
  }
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      {/* shadcn's CommandDialog doesn't provide the cmdk context itself. */}
      <Command>
        <CommandInput placeholder="Search documents or jump to…" value={search} onValueChange={setSearch} />
        <CommandList>
          <CommandEmpty>{results.isFetching ? "Searching…" : "No results."}</CommandEmpty>
          {results.data && results.data.length > 0 && (
            <CommandGroup heading="Documents">
              {results.data.map(({ type, doc }) => (
                <CommandItem key={doc.id} value={`doc-${doc.id}-${search}`} onSelect={() => go(`/content/${type}/${doc.id}`)}>
                  <FileTextIcon />
                  <span className="truncate">{documentTitle(config, type, doc)}</span>
                  <CommandShortcut>{collectionLabel(config, type, false)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Go to">
            <CommandItem onSelect={() => go("/")}><HomeIcon /> Dashboard</CommandItem>
            {types.map(type => (
              <CommandItem key={type} onSelect={() => go(`/content/${type}`)}>
                <Icon name={collectionSettings(config, type).icon} /> {collectionLabel(config, type)}
              </CommandItem>
            ))}
            {session.permissions.media.read && <CommandItem onSelect={() => go("/media")}><ImageIcon /> Media</CommandItem>}
          </CommandGroup>
          <CommandGroup heading="Create">
            {types.filter(t => session.permissions.types[t]?.write && !collectionSettings(config, t).singleton).map(type => (
              <CommandItem key={type} onSelect={() => go(`/content/${type}/new`)}>
                <PlusIcon /> New {collectionLabel(config, type, false).toLowerCase()}
              </CommandItem>
            ))}
          </CommandGroup>
          {plugins.commands.length > 0 && (
            <CommandGroup heading="Commands">
              {plugins.commands.map(command => (
                <CommandItem key={command.id} onSelect={async () => {
                  onOpenChange(false);
                  try {
                    await command.run();
                  } catch (error) {
                    cms.toast((error as Error).message, { type: "error" });
                  }
                }}>{command.label}</CommandItem>
              ))}
            </CommandGroup>
          )}
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
