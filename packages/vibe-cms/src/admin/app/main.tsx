import { keepPreviousData, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { navIcons } from "./icons.ts";
import type { IconName } from "../../icons.ts";
import { FileTextIcon, HomeIcon, ImageIcon, LanguagesIcon, LogOutIcon, MonitorIcon, Trash2Icon, MoonIcon, SunIcon, PlusIcon, SlidersHorizontalIcon, AppWindowIcon, TriangleAlertIcon, UsersIcon, PlugIcon } from "lucide-react";
import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import Fuse from "fuse.js";
import type { AnyConfig } from "../../config.ts";
import { collectDescriptors, IMPL, loadLazy } from "../../descriptor.ts";
import type { AdminPlugin, AdminPluginFactory, AdminClient } from "../index.ts";
import { Button } from "../components/ui/button.tsx";
import { Command, CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "../components/ui/command.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
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
import { SiteSettingsPage } from "./settings.tsx";
import { SignIn } from "./signin.tsx";
import { UsersPage } from "./users.tsx";
import { ConnectApp, ConnectionsPage, takeConnectRequest } from "./connect.tsx";
import { TrashPage } from "./trash.tsx";
import { Link, match, navigate, ParamsContext, setBase, useLocation, useNavigationSync } from "./router.tsx";
import { closePreview, getPreview, onPreviewPick, setPreviewPrefix, showPreview, subscribePreview } from "./preview.ts";
import { openPick, type PreviewPick } from "./reveal.ts";
import { PreviewWindow } from "./preview-window.tsx";
import { MegaNav, type NavGroup, type NavItem } from "./nav.tsx";
import { announcePainted, embedded, getPanelAccent, postToPanel, renewSession, signOut, startSession, subscribePanelAccent } from "./session.ts";

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
  const { config, session, plugins, locale, setLocale, info, cms } = useAdmin();
  const { path } = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const previewOpen = useSyncExternalStore(subscribePreview, () => getPreview().open);
  useNavigationSync();
  useEffect(() => (embedded ? announcePainted() : undefined), []);

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

  const groups: NavGroup[] = [
    {
      key: "content",
      label: "Content",
      items: [
        ...collections.map((type): NavItem => ({
          key: `content:${type}`,
          to: `/content/${type}${locale !== config.defaultLocale ? `?locale=${locale}` : ""}`,
          label: collectionLabel(config, type),
          icon: <Icon name={collectionSettings(config, type).icon ?? "file-text"} />,
          type
        })),
        ...(session.permissions.media.read ? [{ key: "media", to: "/media", label: "Media", icon: <ImageIcon /> } satisfies NavItem] : [])
      ]
    },
    {
      key: "settings",
      label: "Settings",
      items: [
        ...(session.permissions.site ? [{ key: "site", to: "/settings", label: "Site", icon: <SlidersHorizontalIcon /> } satisfies NavItem] : []),
        ...(canManageUsers ? [{ key: "users", to: "/users", label: "Users", icon: <UsersIcon /> } satisfies NavItem] : []),
        ...singletons.map((type): NavItem => ({
          key: `content:${type}`,
          to: `/content/${type}`,
          label: collectionLabel(config, type),
          icon: <Icon name={collectionSettings(config, type).icon ?? "settings"} />,
          type
        }))
      ]
    },
    {
      key: "tools",
      label: "Tools",
      items: plugins.slots.nav!.map((item): NavItem => ({ key: `tool:${item.to}`, to: item.to, label: item.label, icon: <Icon name={item.icon} /> }))
    }
  ].filter(group => group.items.length > 0);

  // Embedded in the panel, the account and its theme switch already live in the panel's own bar.
  const accountMenu = !embedded || canConnect ? (
    <AccountMenu theme={theme} setTheme={setTheme} canConnect={canConnect} onSignOut={onSignOut} />
  ) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-sidebar">
      <MegaNav
        groups={groups}
        isActive={active}
        onSearch={() => setPaletteOpen(true)}
        previewOpen={previewOpen}
        onPreview={() => (previewOpen ? closePreview() : void showPreview(cms))}
        trash={canTrash ? { to: "/trash" } : null}
        account={accountMenu}
      />
      {/* Flush with the window's edges (square corners at the bottom) so the scrollbar runs along the right edge instead of over a rounded corner. */}
      <main data-scroll-root className="relative z-10 flex min-h-0 w-full flex-1 flex-col overflow-y-auto bg-background md:rounded-t-[20px] md:shadow-(--shadow-card)">
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
      </main>
      <ErrorBoundary resetKey={paletteOpen}><Palette open={paletteOpen} onOpenChange={setPaletteOpen} /></ErrorBoundary>
      <ErrorBoundary resetKey={previewOpen}><PreviewWindow /></ErrorBoundary>
      <TipHost />
      <Toaster position="bottom-right" />
    </div>
  );
}

/** The signed-in user: theme, connected apps, sign out. Only where the panel isn't already offering them. */
function AccountMenu({ theme, setTheme, canConnect, onSignOut }: { theme: Theme, setTheme(theme: Theme): void, canConnect: boolean, onSignOut(): void }) {
  const { session, info } = useAdmin();
  const name = session.user.name ?? session.user.email ?? "Account";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <button type="button" aria-label={name} title={info.dev && !embedded ? "Development mode: signed in without an identity provider" : name} className="ml-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-xs font-medium outline-none transition-[background-color,scale] duration-150 hover:bg-foreground/[0.12] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96]">
          {name.charAt(0).toUpperCase()}
        </button>
      } />
      <DropdownMenuContent side="bottom" align="end" className="w-56">
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
