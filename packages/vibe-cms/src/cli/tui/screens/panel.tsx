import { Box, Text } from "ink";
import { openBrowser } from "../../login.ts";
import { useNav, useSession, type Session } from "../app.tsx";
import type { Field, FormValues } from "../fields.ts";
import { panelArgs, type PanelOptions } from "../panel.ts";
import { copy, useSticky } from "../system.ts";
import { accent, Form, Spinner, useFlash, useHints, useKeys, useSize } from "../ui.tsx";
import { commandLine } from "./commands.tsx";

export const PANEL_PORT = "5183";

const fields: Field[] = [
  { key: "port", label: "Port", kind: "number", required: false, placeholder: PANEL_PORT, description: "The next free one is used if it's taken" },
  { key: "site", label: "Open site", kind: "string", required: false, placeholder: "the site you're on", description: "Open this site once the panel loads" },
  { key: "name", label: "Agency name", kind: "string", required: false },
  { key: "accent", label: "Accent", kind: "string", required: false, placeholder: "#6d28d9" },
  { key: "icon", label: "Logo", kind: "string", required: false, placeholder: "URL or path" }
];

/** The panel's settings as last set here, with the site you're on when none is given. */
export function panelOptions(values: FormValues, session: Session): PanelOptions {
  function text(value: FormValues[string]) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  return { port: text(values.port) ?? PANEL_PORT, site: text(values.site) ?? session.site?.url, name: text(values.name), accent: text(values.accent), icon: text(values.icon) };
}

/** Starts the panel, or opens it once it's running: what `p` does on the home screen. */
export function usePanelToggle(): () => void {
  const session = useSession();
  const [values] = useSticky<FormValues>("panel", {});
  return () => {
    if(session.panel.status === "running" && session.panel.url) openBrowser(session.panel.url);
    else if(session.panel.status !== "starting") session.startPanel(panelOptions(values, session));
  };
}

export function PanelScreen() {
  const session = useSession();
  const nav = useNav();
  const { width, height } = useSize();
  const [values, setValues] = useSticky<FormValues>("panel", {});
  const [flash, setFlash] = useFlash();
  const { panel } = session;
  const live = panel.status === "running" || panel.status === "starting";
  const options = panelOptions(values, session);

  useHints([
    { keys: "↑↓", label: "field" },
    { keys: "⌃R", label: live ? "restart" : "start" },
    ...live ? [{ keys: "⌃X", label: "stop" }] : [],
    ...panel.url ? [{ keys: "⌃O", label: "open in browser" }, { keys: "⌃Y", label: "copy link" }] : [],
    { keys: "esc", label: "back (it keeps running)" }
  ]);
  useKeys((input, key) => {
    if(key.escape) nav.pop();
    else if(key.ctrl && input === "x" && live) session.stopPanel();
    else if(key.ctrl && input === "o" && panel.url) openBrowser(panel.url);
    else if(key.ctrl && input === "y" && panel.url) setFlash(copy(panel.url));
  });

  const logRows = Math.max(3, height - fields.length - 14);
  return (
    <Box flexDirection="column">
      <Text bold color={accent}>Local panel</Text>
      <Box marginBottom={1}><Text dimColor wrap="wrap">An agency panel for development sites, kept in the browser. It runs in the background while you use the rest of this, and stops when you quit.</Text></Box>
      <Box marginBottom={1}>
        {panel.status === "running" ? <Text><Text color="green" bold>● Running</Text>  <Text color="cyan">{panel.url}</Text></Text>
          : panel.status === "starting" ? <Spinner label="Starting…" />
            : panel.status === "failed" ? <Text color="red">✗ {panel.error ?? "It didn't start."}</Text>
              : <Text dimColor>○ Not running</Text>}
      </Box>
      <Form fields={fields} values={values} onChange={setValues} onSubmit={() => session.startPanel(options)} stickyKey="panel" width={width} submitLabel={live ? "Restart" : "Start"} />
      <Box flexDirection="column">
        <Text dimColor>Same as</Text>
        <Text color="cyan" wrap="truncate-end">{commandLine(panelArgs(options))}</Text>
      </Box>
      {panel.log.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Output</Text>
          {panel.log.slice(-logRows).map((line, i) => <Text key={i} dimColor wrap="truncate-end">{`  ${line}`}</Text>)}
        </Box>
      ) : null}
      {flash ? <Text color="green">{flash}</Text> : null}
    </Box>
  );
}
