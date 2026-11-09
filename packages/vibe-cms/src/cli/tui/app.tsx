import { Box, Text, useApp, useWindowSize } from "ink";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ActionDescription } from "../../actions/describe.ts";
import { discoverSites, type Discovery } from "./discover.ts";
import { startPanel, stopAllPanels, type PanelOptions, type PanelState } from "./panel.ts";
import { authorize, siteActions, siteName, type Auth, type Site } from "./site.ts";
import { readSettings, rememberSite, runInTerminal } from "./system.ts";
import { accent, ActiveContext, HintsContext, SizeContext, type Hint } from "./ui.tsx";

/** What every screen shares: the site, the session on it, its actions, and the terminal. */
export interface Session {
  site: Site | null,
  status: "none" | "connecting" | "ready" | "unreachable",
  auth: Auth | null,
  actions: ActionDescription[],
  /** Whether the actions came from the site (plugins' included) or are the built-in list. */
  actionsFromSite: boolean,
  recent: Site[],
  /** Vibe CMS sites running on this machine, once looked for. */
  local: Discovery | "scanning",
  /** Looks for local sites again. */
  scan(): Promise<Discovery>,
  connect(site: Site): Promise<void>,
  reconnect(): Promise<void>,
  /** The local panel running in the background, if one is. */
  panel: PanelState,
  startPanel(options: PanelOptions): void,
  stopPanel(): void,
  /** Runs `vibe-cms <args>` with the terminal to itself, then comes back. Signs in again after logins. */
  runCommand(args: string[], options?: { pause?: boolean }): Promise<number>,
  version: string
}

const SessionContext = createContext<Session>(null as never);

export function useSession() {
  return useContext(SessionContext);
}

interface Screen {
  id: number,
  title: string,
  node: ReactNode
}

export interface Nav {
  push(title: string, node: ReactNode): void,
  pop(): void,
  /** Swaps the screen showing for another, as a step that shouldn't be gone back to. */
  replace(title: string, node: ReactNode): void,
  home(): void
}

const NavContext = createContext<Nav>(null as never);

export function useNav() {
  return useContext(NavContext);
}

/** The header's account of the site: which, where, and as whom. */
function siteStatus(session: Session): { name?: string, text: string, color: string } {
  if(!session.site) return { text: "no site · press s to choose one", color: "gray" };
  const name = session.site.name;
  const host = session.site.url.replace(/^https?:\/\//, "") + (session.site.prefix === "/_vibe" ? "" : session.site.prefix);
  switch(session.status) {
    case "connecting": return { name, text: `◌ ${host} · connecting…`, color: "yellow" };
    case "unreachable": return { name, text: `○ ${host} · can't reach it`, color: "red" };
    default: {
      const via = session.auth?.via;
      if(!via || via === "none") return { name, text: `○ ${host} · not signed in`, color: "yellow" };
      return { name, text: `● ${host} · ${via === "dev" ? "dev session" : via === "hub" ? "via your org" : via === "site login" ? "logged in" : "token"}`, color: "green" };
    }
  }
}

export function App({ home, version, initialSite }: { home: (nav: Nav) => ReactNode, version: string, initialSite?: Site }) {
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  const [site, setSite] = useState<Site | null>(initialSite ?? null);
  const [status, setStatus] = useState<Session["status"]>(initialSite ? "connecting" : "none");
  const [auth, setAuth] = useState<Auth | null>(null);
  const [actions, setActions] = useState<{ list: ActionDescription[], fromSite: boolean }>({ list: [], fromSite: false });
  const [recent, setRecent] = useState<Site[]>([]);
  const [local, setLocal] = useState<Discovery | "scanning">("scanning");
  const [hints, setHints] = useState<Hint[]>([]);
  const [panel, setPanel] = useState<PanelState>({ status: "stopped", log: [] });
  const panelRef = useRef<{ stop(): void } | null>(null);
  const panelRun = useRef<object>(undefined);
  const attempt = useRef(0);

  const connect = useCallback(async (next: Site | null) => {
    const mine = ++attempt.current;
    setSite(next);
    setAuth(null);
    setStatus(next ? "connecting" : "none");
    if(next) setRecent(await rememberSite(next));
    // The name comes alongside, and is remembered with the site for the recent list.
    if(next) {
      void siteName(next).then(name => {
        if(mine !== attempt.current || !name) return;
        setSite(current => current && current.url === next.url && current.prefix === next.prefix ? { ...current, name } : current);
        void rememberSite({ ...next, name }).then(setRecent);
      });
    }
    let session: Auth | null = null;
    if(next) {
      try {
        session = await authorize(next);
      } catch (error) {
        session = { via: "none", problem: (error as Error).message, canLogIn: false };
      }
    }
    const listed = await siteActions(next, session?.token);
    if(mine !== attempt.current) return;
    setAuth(session);
    setActions({ list: listed.actions, fromSite: listed.fromSite });
    setStatus(!next ? "none" : listed.fromSite || session?.token ? "ready" : await fetch(`${next.url}${next.prefix}/api/actions`, { signal: AbortSignal.timeout(5000) }).then(() => "ready" as const, () => "unreachable" as const));
  }, []);

  const siteRef = useRef(site);
  siteRef.current = site;

  useEffect(() => {
    void readSettings().then(settings => setRecent(settings.sites));
    void connect(initialSite ?? null);
    // Without VIBE_SITE, the one site running here is the obvious one to work on.
    void scan().then(found => {
      if(!initialSite && !siteRef.current && found.ok && found.sites.length === 1) {
        const [only] = found.sites;
        void connect({ url: only!.url, prefix: only!.prefix });
      }
    });
  }, []);

  const scan = useCallback(async () => {
    setLocal("scanning");
    const found = await discoverSites().catch((error: Error): Discovery => ({ ok: false, reason: error.message }));
    setLocal(found);
    return found;
  }, []);

  const runCommand = useCallback(async (args: string[], options?: { pause?: boolean }) => {
    let code = 1;
    await suspendTerminal(async () => {
      code = await runInTerminal(args, options);
    });
    if(args[0] === "login" || args[0] === "logout") await connect(siteRef.current);
    return code;
  }, [suspendTerminal, connect]);

  const runPanel = useCallback((options: PanelOptions) => {
    panelRef.current?.stop();
    // Only the latest panel's news counts: one being restarted reports its own end too.
    const run = {};
    panelRun.current = run;
    panelRef.current = startPanel(options, next => {
      if(panelRun.current === run) setPanel(next);
    });
  }, []);
  const stopPanel = useCallback(() => panelRef.current?.stop(), []);
  // Leaving the TUI stops the panel with it.
  useEffect(() => stopAllPanels, []);

  const session: Session = {
    site,
    status,
    auth,
    actions: actions.list,
    actionsFromSite: actions.fromSite,
    recent,
    local,
    scan,
    connect: next => connect(next),
    reconnect: () => connect(siteRef.current),
    panel,
    startPanel: runPanel,
    stopPanel,
    runCommand,
    version
  };

  const nextId = useRef(1);
  const [stack, setStack] = useState<Screen[]>([]);
  const nav: Nav = useMemo(() => ({
    push: (title, node) => setStack(s => [...s, { id: nextId.current++, title, node }]),
    pop: () => setStack(s => s.length > 1 ? s.slice(0, -1) : s),
    replace: (title, node) => setStack(s => [...s.slice(0, -1), { id: nextId.current++, title, node }]),
    home: () => setStack(s => s.slice(0, 1))
  }), []);
  useEffect(() => {
    setStack([{ id: 0, title: "Home", node: home(nav) }]);
  }, []);
  void exit;

  const width = Math.max(40, columns);
  const height = Math.max(12, rows);
  const body = { width: width - 4, height: height - 3 };
  const state = siteStatus(session);
  const crumbs = stack.slice(1).map(s => s.title);

  return (
    <SessionContext.Provider value={session}>
      <NavContext.Provider value={nav}>
        <HintsContext.Provider value={setHints}>
          <Box flexDirection="column" width={width} height={height}>
            <Box paddingX={1} justifyContent="space-between">
              <Text wrap="truncate-end">
                <Text color={accent} bold>◆ Vibe CMS</Text>
                <Text dimColor> v{version}</Text>
                {crumbs.map((c, i) => <Text key={i}><Text dimColor>  ›  </Text><Text bold={i === crumbs.length - 1}>{c}</Text></Text>)}
              </Text>
              <Text wrap="truncate-start">
                {panel.status === "running" || panel.status === "starting" ? (
                  <Text color={panel.status === "running" ? "green" : "yellow"}>{`▣ panel${panel.url ? ` :${new URL(panel.url).port}` : "…"}`}<Text dimColor>   </Text></Text>
                ) : null}
                {state.name ? <Text bold>{state.name}  </Text> : null}
                <Text color={state.color}>{state.text}</Text>
              </Text>
            </Box>
            <Box paddingX={1}><Text dimColor>{"─".repeat(Math.max(0, width - 2))}</Text></Box>
            <SizeContext.Provider value={body}>
              <Box flexGrow={1} paddingX={2} overflow="hidden">
                {stack.map((screen, i) => (
                  <Box key={screen.id} display={i === stack.length - 1 ? "flex" : "none"} flexDirection="column" flexGrow={1}>
                    <ActiveContext.Provider value={i === stack.length - 1}>{screen.node}</ActiveContext.Provider>
                  </Box>
                ))}
              </Box>
            </SizeContext.Provider>
            <Box paddingX={1}>
              <Text wrap="truncate-end">
                {hints.map((hint, i) => <Text key={i}><Text color={accent} bold>{hint.keys}</Text><Text dimColor> {hint.label}{i < hints.length - 1 ? "   " : ""}</Text></Text>)}
              </Text>
            </Box>
          </Box>
        </HintsContext.Provider>
      </NavContext.Provider>
    </SessionContext.Provider>
  );
}
