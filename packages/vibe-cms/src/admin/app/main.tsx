import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { navIcons } from "./icons.ts";
import { FileTextIcon, HomeIcon, ImageIcon, LanguagesIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon, PlusIcon, SearchIcon, KeyRoundIcon } from "lucide-react";
import { StrictMode, useEffect, useMemo, useState, type ComponentType } from "react";
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
import { Delayed } from "./delayed.tsx";
import { Dashboard, DocumentRoute, ListPage, MediaPage } from "./pages.tsx";
import { Link, match, navigate, ParamsContext, setBase, useLocation, useNavigationSync } from "./router.tsx";
import { embedded, postToPanel, renewSession, signOut, startSession } from "./session.ts";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } }
});

/** Collections and plugins name an icon from this set, or pass their own component. */
function Icon({ name, className }: { name?: string | ComponentType<{ className?: string }>, className?: string }) {
  if(typeof name === "function") {
    const Component = name;
    return <Component className={className} />;
  }
  const Component = (name && navIcons[name]) || FileTextIcon;
  return <Component className={className} />;
}

type Theme = "light" | "dark" | "system";

function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("vibe:theme") as Theme | null) ?? "system");
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    function apply() {
      document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && media.matches));
    }
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem("vibe:theme", theme);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return [theme, setTheme];
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
    <Centered>
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <KeyRoundIcon className="size-5" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold">{info.site.name}</h1>
          <p className="text-sm text-muted-foreground">
            {embedded
              ? "Waiting for your agency panel to sign you in…"
              : "Open this editor from your agency's panel to sign in. Sessions are handed over from the panel; this page has no password form."}
          </p>
          {info.auth && <p className="text-xs text-muted-foreground">Identity provider: {new URL(info.auth.issuer).host}</p>}
        </div>
        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </div>
    </Centered>
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
  const value: AdminContextValue = { config, info, session, cms, plugins, locale, setLocale };
  return (
    <AdminContext.Provider value={value}>
      <Layout onSignOut={onSignOut} />
    </AdminContext.Provider>
  );
}

function Layout({ onSignOut }: { onSignOut(): void }) {
  const { config, session, plugins, locale, setLocale, info, cms } = useAdmin();
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
    <SidebarProvider className="h-full min-h-0">
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link to="/" />} tooltip={config.name ?? info.site.name}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
                  {(config.name ?? info.site.name).charAt(0).toUpperCase()}
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">{config.name ?? info.site.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{location.host}</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive={active("/")} render={<Link to="/" />} tooltip="Dashboard"><HomeIcon /> <span>Dashboard</span></SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={() => setPaletteOpen(true)} tooltip="Search">
                    <SearchIcon /> <span>Search</span>
                    <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">⌘J</Kbd>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Content</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {collections.map(type => (
                  <SidebarMenuItem key={type}>
                    <SidebarMenuButton isActive={active(`/content/${type}`)} render={<Link to={`/content/${type}${locale !== config.defaultLocale ? `?locale=${locale}` : ""}`} />} tooltip={collectionLabel(config, type)}>
                      <Icon name={collectionSettings(config, type).icon ?? "file-text"} />
                      <span>{collectionLabel(config, type)}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                {session.permissions.media.read && (
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive={active("/media")} render={<Link to="/media" />} tooltip="Media"><ImageIcon /> <span>Media</span></SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {singletons.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>Settings</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {singletons.map(type => (
                    <SidebarMenuItem key={type}>
                      <SidebarMenuButton isActive={active(`/content/${type}`)} render={<Link to={`/content/${type}`} />} tooltip={collectionLabel(config, type)}>
                        <Icon name={collectionSettings(config, type).icon ?? "settings"} />
                        <span>{collectionLabel(config, type)}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          {plugins.slots.nav!.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>Tools</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {plugins.slots.nav!.map(item => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton isActive={active(item.to)} render={<Link to={item.to} />} tooltip={item.label}>
                        <Icon name={item.icon} /> <span>{item.label}</span>
                      </SidebarMenuButton>
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
      <SidebarInset className="min-h-0 overflow-y-auto">
        <div className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
          <SidebarTrigger />
        </div>
        <div className="pointer-events-none fixed top-3 right-4 z-30 hidden md:block">
          {config.locales!.length > 1 && (
            <div className="pointer-events-auto">
              <LocaleMenu locale={locale} setLocale={setLocale} />
            </div>
          )}
        </div>
        <ErrorBoundary resetKey={path}>{page}</ErrorBoundary>
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
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="bg-background/80 backdrop-blur"><LanguagesIcon /> {localeName(locale)}</Button>} />
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={locale} onValueChange={next => setLocale(next as string)}>
          {config.locales!.map(l => <DropdownMenuRadioItem key={l} value={l}>{localeName(l)}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
