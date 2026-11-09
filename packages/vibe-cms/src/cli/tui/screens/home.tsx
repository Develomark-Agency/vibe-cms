import { Box, Text, useApp } from "ink";
import { useState, type ReactNode } from "react";
import { useNav, useSession, type Session } from "../app.tsx";
import { shellQuote } from "../fields.ts";
import { accent, List, useHints, useKeys, useSize, type ListItem } from "../ui.tsx";
import { ActionsScreen } from "./actions.tsx";
import { ExportScreen, ImportScreen } from "./backups.tsx";
import { panelArgs } from "../panel.ts";
import { CommandScreen, commandLine, commands } from "./commands.tsx";
import { PanelScreen, panelOptions, usePanelToggle } from "./panel.tsx";
import { DocsScreen } from "./docs.tsx";
import { ClaimLinkScreen, KeygenScreen } from "./tools.tsx";
import { SiteScreen } from "./site.tsx";

interface Entry {
  id: string,
  section: string,
  label: string,
  description: string,
  /** The same thing in the headless CLI. */
  command: (session: Session) => string,
  /** Needs a site to work on. */
  needsSite?: boolean,
  open: () => { title: string, node: ReactNode }
}

function siteFlag(session: Session) {
  return session.site ? ` --site ${shellQuote(session.site.url)}${session.site.prefix === "/_vibe" ? "" : ` --prefix ${session.site.prefix}`}` : " --site <url>";
}

const entries: Entry[] = [
  {
    id: "site",
    section: "Site",
    label: "Choose a site",
    description: "The site the content actions, backups and site logins work on: a development site at localhost, or a deployed one. Recent sites are remembered.",
    command: () => "--site <url>, or VIBE_SITE",
    open: () => ({ title: "Site", node: <SiteScreen /> })
  },
  {
    id: "actions",
    section: "Content",
    label: "Run an action",
    description: "Every action the editor uses — schema, documents, assets, folders, trash, site settings, backups — and the ones the site's plugins add. Each gets a form from its input; the result comes back as JSON.",
    command: session => `vibe-cms <group> <action>${siteFlag(session)}`,
    needsSite: true,
    open: () => ({ title: "Actions", node: <ActionsScreen /> })
  },
  {
    id: "export",
    section: "Backups",
    label: "Export the site",
    description: "Save the site's content and media as one .vibe file.",
    command: session => `vibe-cms export${siteFlag(session)}`,
    needsSite: true,
    open: () => ({ title: "Export", node: <ExportScreen /> })
  },
  {
    id: "import",
    section: "Backups",
    label: "Import a .vibe file",
    description: "Replace the site's content and media with a .vibe file's. Shows what would change first, and exports the site as it is before replacing anything.",
    command: session => `vibe-cms import <file.vibe>${siteFlag(session)}`,
    needsSite: true,
    open: () => ({ title: "Import", node: <ImportScreen /> })
  },
  {
    id: "panel",
    section: "Panel",
    label: "Local panel",
    description: "An agency panel for development sites, kept in the browser. p starts it in the background, so you can carry on here; it stops when you quit. Enter for its settings, its output, and stopping it.",
    command: session => commandLine(panelArgs(panelOptions({}, session))),
    open: () => ({ title: "Local panel", node: <PanelScreen /> })
  },
  ...commands.map((command): Entry => ({
    id: command.id,
    section: command.section,
    label: command.label,
    description: command.description,
    command: session => command.preview(session),
    open: () => ({ title: command.title, node: <CommandScreen command={command} /> })
  })),
  {
    id: "claim-link",
    section: "Panel",
    label: "Find a site's claim link",
    description: "Print a new site's claim link, for when you missed it in the site's logs. Finds the site's database through your wrangler login.",
    command: () => "vibe-cms admin claim-link <site>",
    open: () => ({ title: "Claim link", node: <ClaimLinkScreen /> })
  },
  {
    id: "keygen",
    section: "Tools",
    label: "Generate a hub signing key",
    description: "A new signing key for a hub you run by hand, for its HUB_SIGNING_KEY secret.",
    command: () => "vibe-cms hub keygen",
    open: () => ({ title: "Hub key", node: <KeygenScreen /> })
  },
  {
    id: "docs",
    section: "Guides",
    label: "Read the guides",
    description: "The Vibe CMS guides: schemas, plugins, framework setup, deploying, agents. Search across all of them with /.",
    command: () => "vibe-cms docs [topic]",
    open: () => ({ title: "Guides", node: <DocsScreen /> })
  }
];

const order = ["Site", "Content", "Backups", "Account", "Panel", "Tools", "Guides"];

export function Home() {
  const session = useSession();
  const nav = useNav();
  const { exit } = useApp();
  const { width, height } = useSize();
  const [current, setCurrent] = useState<Entry>(entries[0]!);
  const sorted = order.flatMap(section => entries.filter(e => e.section === section));
  const items: ListItem[] = [];
  for(const entry of sorted) {
    if(items.at(-1)?.id !== `h:${entry.section}` && !items.some(i => i.id === `h:${entry.section}`)) {
      if(items.length) items.push({ id: `gap:${entry.section}`, label: " ", heading: true });
      items.push({ id: `h:${entry.section}`, label: entry.section.toUpperCase(), heading: true });
    }
    const panel = entry.id === "panel" ? session.panel : undefined;
    items.push({
      id: entry.id,
      label: entry.label,
      color: entry.needsSite && !session.site ? "gray" : undefined,
      hint: !panel ? undefined : panel.status === "running" ? `● :${new URL(panel.url!).port}` : panel.status === "starting" ? "starting…" : "p to start"
    });
  }

  function open(entry: Entry) {
    const { title, node } = entry.open();
    if(entry.needsSite && !session.site) {
      nav.push("Site", <SiteScreen then={() => nav.replace(title, node)} />);
      return;
    }
    nav.push(title, node);
  }

  const togglePanel = usePanelToggle();
  useHints([
    { keys: "↑↓", label: "move" },
    { keys: "enter", label: "open" },
    { keys: "s", label: "site" },
    { keys: "a", label: "actions" },
    { keys: "p", label: session.panel.status === "running" ? "open panel" : "start panel" },
    { keys: "d", label: "guides" },
    { keys: "q", label: session.panel.status === "running" ? "quit (stops the panel)" : "quit" }
  ]);
  useKeys(input => {
    if(input === "q") exit();
    else if(input === "p") togglePanel();
    else if(input === "s") open(entries.find(e => e.id === "site")!);
    else if(input === "a") open(entries.find(e => e.id === "actions")!);
    else if(input === "d") open(entries.find(e => e.id === "docs")!);
  });

  const listWidth = Math.min(38, Math.max(30, Math.floor(width * 0.34)));
  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box width={listWidth} flexShrink={0} flexDirection="column">
        <List items={items} height={height - 1} stickyKey="home" onHighlight={item => setCurrent(entries.find(e => e.id === item?.id) ?? entries[0]!)} onSelect={item => open(entries.find(e => e.id === item.id)!)} />
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingLeft={2} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray">
        <Text bold color={accent}>{current.label}</Text>
        <Box marginTop={1}><Text wrap="wrap">{current.description}</Text></Box>
        {current.id === "site" ? <SiteSummary /> : null}
        {current.id === "panel" ? (
          <Box marginTop={1}>
            {session.panel.status === "running" ? <Text><Text color="green">● Running at </Text><Text color="cyan">{session.panel.url}</Text><Text dimColor>  p opens it</Text></Text>
              : session.panel.status === "starting" ? <Text color="yellow">Starting…</Text>
                : session.panel.status === "failed" ? <Text color="red">✗ {session.panel.error}</Text>
                  : <Text dimColor>Not running: p starts it.</Text>}
          </Box>
        ) : null}
        {current.needsSite && !session.site ? <Box marginTop={1}><Text color="yellow">Choose a site first: Enter asks for one.</Text></Box> : null}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>From the command line</Text>
          <Text color="cyan" wrap="wrap">{current.command(session)}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/** Where the TUI is connected, and how it's signed in. */
export function SiteSummary() {
  const session = useSession();
  if(!session.site) return <Box marginTop={1}><Text dimColor>No site chosen yet.</Text></Box>;
  const auth = session.auth;
  const how = !auth ? "…" : {
    token: "with the token in VIBE_TOKEN",
    dev: "with a development session (the site runs in dev mode)",
    "site login": "with your login to this site",
    hub: "through your org's hub login for this project",
    none: "not signed in"
  }[auth.via];
  return (
    <Box marginTop={1} flexDirection="column">
      {session.site.name ? <Text><Text dimColor>Name     </Text><Text bold>{session.site.name}</Text></Text> : null}
      <Text><Text dimColor>Site     </Text>{session.site.url}<Text dimColor>{session.site.prefix === "/_vibe" ? "" : session.site.prefix}</Text></Text>
      <Text><Text dimColor>Session  </Text><Text color={auth?.token ? "green" : "yellow"}>{session.status === "unreachable" ? "can't reach the site" : how}</Text></Text>
      {session.status === "ready" ? <Text><Text dimColor>Actions  </Text>{session.actions.length}{session.actions.some(a => a.plugin) ? ` (${session.actions.filter(a => a.plugin).length} from plugins)` : ""}</Text> : null}
      {auth?.problem ? <Text color="yellow" wrap="wrap">{auth.problem}</Text> : null}
      {auth && auth.via === "none" && auth.canLogIn ? <Text color="yellow">This site signs the CLI in itself: Account › Log in to this site.</Text> : null}
    </Box>
  );
}
