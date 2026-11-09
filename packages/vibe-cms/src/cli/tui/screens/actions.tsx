import { writeFile } from "node:fs/promises";
import path from "node:path";
import Fuse from "fuse.js";
import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import { httpCaller } from "../../../actions/client.ts";
import type { ActionDescription } from "../../../actions/describe.ts";
import { isActionError } from "../../../actions/errors.ts";
import { useNav, useSession } from "../app.tsx";
import { actionCommandLine, fieldsFromSchema, toInput, type FormValues } from "../fields.ts";
import { copy, useSticky } from "../system.ts";
import { jsonLines } from "../text.ts";
import { accent, Confirm, ErrorBox, Form, List, Spinner, TextInput, useFlash, useHints, useKeys, useSize, Viewer, type ListItem } from "../ui.tsx";

function kebab(name: string) {
  return name.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
}

/** `documents.restoreVersion` as the CLI spells it: `documents restore-version`. */
export function cliName(action: ActionDescription): string {
  if(action.plugin) return action.name;
  const [group, ...rest] = action.name.split(".");
  return `${group} ${kebab(rest.join("."))}`;
}

function badges(action: ActionDescription) {
  const out: Array<{ text: string, color: string }> = [];
  if(action.annotations.readOnly) out.push({ text: "read-only", color: "green" });
  if(action.annotations.destructive) out.push({ text: "destructive", color: "red" });
  else if(!action.annotations.readOnly) out.push({ text: "writes", color: "yellow" });
  if(action.plugin) out.push({ text: `plugin: ${action.plugin}`, color: "cyan" });
  if(!action.mcp) out.push({ text: "not an MCP tool", color: "gray" });
  return out;
}

/** Descriptions name other actions as `schema.list`; here they read as the CLI writes them. */
function mentions(text: string): string {
  return text.replace(/`(\w+)\.(\w+)`/g, (_, group: string, verb: string) => `\`${group} ${kebab(verb)}\``);
}

/** Every action on the site, grouped, with a filter to type into. */
export function ActionsScreen() {
  const session = useSession();
  const nav = useNav();
  const { width, height } = useSize();
  const [query, setQuery] = useSticky("actions:query", "");
  const [current, setCurrent] = useState<ActionDescription>();
  const fuse = useMemo(() => new Fuse(session.actions, { keys: [{ name: "name", weight: 3 }, { name: "title", weight: 2 }, "description", "plugin"], threshold: 0.4, ignoreLocation: true }), [session.actions]);

  const items: ListItem[] = useMemo(() => {
    if(query.trim()) return fuse.search(query.trim()).map(({ item }) => ({ id: item.name, label: cliName(item), hint: item.title, mark: item.annotations.destructive ? { text: "!", color: "red" } : undefined }));
    const list: ListItem[] = [];
    let group = "";
    for(const action of session.actions) {
      const heading = action.plugin ? `PLUGIN · ${action.plugin.toUpperCase()}` : action.name.split(".")[0]!.toUpperCase();
      if(heading !== group) {
        if(group) list.push({ id: `gap:${heading}`, label: " ", heading: true });
        list.push({ id: `h:${heading}`, label: heading, heading: true });
        group = heading;
      }
      list.push({ id: action.name, label: action.plugin ? action.name : kebab(action.name.split(".").slice(1).join(".")), hint: action.title, mark: action.annotations.destructive ? { text: "!", color: "red" } : undefined });
    }
    return list;
  }, [query, session.actions, fuse]);

  function open(name: string) {
    const action = session.actions.find(a => a.name === name);
    if(action) nav.push(cliName(action), <ActionRunScreen action={action} />);
  }

  const canLogIn = session.auth?.via === "none" && session.auth.canLogIn;
  useHints([
    { keys: "type", label: "filter" },
    { keys: "↑↓", label: "move" },
    { keys: "enter", label: "open" },
    ...canLogIn ? [{ keys: "⌃L", label: "log in to this site" }] : [],
    { keys: "⌃O", label: "reconnect" },
    { keys: "esc", label: query ? "clear filter" : "back" }
  ]);
  useKeys((input, key) => {
    if(key.escape) {
      if(query) setQuery("");
      else nav.pop();
    } else if(key.ctrl && input === "l" && canLogIn && session.site) {
      void session.runCommand(["login", "--site", session.site.url, "--prefix", session.site.prefix]);
    } else if(key.ctrl && input === "o") void session.reconnect();
  });

  const listWidth = Math.min(48, Math.max(30, Math.floor(width * 0.42)));
  const fields = current ? fieldsFromSchema(current.input) : [];
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text color={accent}>⌕ </Text>
        <Box width={listWidth - 2}><TextInput value={query} onChange={setQuery} placeholder="Filter actions…" width={listWidth - 2} /></Box>
        <Box flexGrow={1} justifyContent="flex-end">
          {session.status === "connecting" ? <Spinner label="Loading the site's actions" /> : (
            <Text dimColor>{session.actionsFromSite ? `${session.actions.length} actions on this site` : "built-in actions (couldn't list the site's)"}</Text>
          )}
        </Box>
      </Box>
      {session.auth?.via === "none" ? (
        <Text color="yellow" wrap="truncate-end">
          {session.auth.problem ?? "Not signed in: actions that need a user will be refused."}
          {canLogIn ? " ⌃L logs in to this site." : session.auth.problem ? "" : " Log in from Account on the home screen."}
        </Text>
      ) : <Text> </Text>}
      <Box flexGrow={1}>
        <Box width={listWidth} flexShrink={0} flexDirection="column">
          {items.length ? <List items={items} height={height - 3} vim={false} stickyKey={`actions:list:${query.trim()}`} onHighlight={item => setCurrent(session.actions.find(a => a.name === item?.id))} onSelect={item => open(item.id)} />
            : <Text dimColor>Nothing matches "{query}".</Text>}
        </Box>
        {current ? (
          <Box flexDirection="column" flexGrow={1} paddingLeft={2} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray">
            <Text bold color={accent}>{current.title}</Text>
            <Text dimColor>{current.name}</Text>
            <Box marginTop={1} gap={1} flexWrap="wrap">
              {badges(current).map(b => <Text key={b.text} color={b.color}>[{b.text}]</Text>)}
            </Box>
            <Box marginTop={1}><Text wrap="wrap">{mentions(current.description)}</Text></Box>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>{fields.length ? "Input" : "Takes no input"}</Text>
              {fields.slice(0, Math.max(0, height - 14)).map(f => (
                <Text key={f.key} wrap="truncate-end">
                  <Text color={f.required ? "white" : undefined} bold={f.required}>{f.key}</Text>
                  {f.required ? <Text color={accent}>*</Text> : null}
                  <Text dimColor>  {f.kind === "enum" ? f.options?.join("|") : f.kind}{f.description ? ` · ${mentions(f.description)}` : ""}</Text>
                </Text>
              ))}
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

type Outcome =
  | { ok: true, value: unknown, ms: number }
  | { ok: false, code: string, message: string, data?: unknown, ms: number };

/** One action: its form, then its result. */
export function ActionRunScreen({ action }: { action: ActionDescription }) {
  const session = useSession();
  const nav = useNav();
  const { width, height } = useSize();
  const fields = useMemo(() => fieldsFromSchema(action.input), [action]);
  const [values, setValues] = useSticky<FormValues>(`action:${action.name}`, {});
  const [mode, setMode] = useState<"form" | "confirm" | "running" | "result">("form");
  const [outcome, setOutcome] = useState<Outcome>();
  const [problem, setProblem] = useState<string>();
  const [flash, setFlash] = useFlash();

  async function run() {
    if(!session.site) return setProblem("Choose a site first");
    setProblem(undefined);
    let input: Record<string, unknown>;
    try {
      input = await toInput(fields, values);
    } catch (error) {
      return setProblem((error as Error).message);
    }
    setMode("running");
    const started = performance.now();
    const call = httpCaller({ url: session.site.url, prefix: session.site.prefix, token: session.auth?.token });
    try {
      const value = await call(action.name, input);
      setOutcome({ ok: true, value, ms: performance.now() - started });
    } catch (error) {
      const ms = performance.now() - started;
      if(isActionError(error)) setOutcome({ ok: false, code: error.code, message: error.message, data: error.data, ms });
      else setOutcome({ ok: false, code: "FAILED", message: (error as Error).message === "fetch failed" ? `Couldn't reach ${session.site.url}` : (error as Error).message, ms });
    }
    setMode("result");
  }
  function submit() {
    if(action.annotations.destructive) setMode("confirm");
    else void run();
  }

  // Actions that only read and take nothing run as soon as they're opened.
  useEffect(() => {
    if(!fields.length && action.annotations.readOnly && session.site) void run();
  }, []);

  async function save() {
    if(!outcome?.ok) return;
    const file = `${action.name.replace(/\./g, "-")}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`;
    await writeFile(path.resolve(file), `${JSON.stringify(outcome.value, null, 2)}\n`);
    setFlash(`Saved ${file}`);
  }

  const commandLine = actionCommandLine(action, fields, values, session.site ?? undefined);
  useHints(mode === "result"
    ? [{ keys: "↑↓ space", label: "scroll" }, { keys: "c", label: "copy" }, { keys: "w", label: "save" }, { keys: "r", label: "run again" }, ...fields.length ? [{ keys: "e", label: "edit" }] : [], { keys: "y", label: "copy command" }, { keys: "esc", label: fields.length ? "edit" : "back" }]
    : mode === "form"
      ? [{ keys: "↑↓", label: "field" }, { keys: "⌃R", label: "run" }, { keys: "⌃Y", label: "copy command" }, { keys: "esc", label: "back" }]
      : []);
  useKeys((input, key) => {
    if(mode === "form") {
      if(key.escape) nav.pop();
      else if(key.ctrl && input === "y") setFlash(copy(commandLine));
      return;
    }
    if(mode !== "result") return;
    if(key.escape || input === "e") {
      if(fields.length) setMode("form");
      else nav.pop();
    } else if(input === "r") submit();
    else if(input === "c" && outcome) setFlash(copy(outcome.ok ? JSON.stringify(outcome.value, null, 2) : `${outcome.code} ${outcome.message}`));
    else if(input === "w") void save();
    else if(input === "y") setFlash(copy(commandLine));
  });

  const lines = useMemo(() => outcome ? jsonLines(outcome.ok ? outcome.value : outcome.data) : [], [outcome]);
  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold color={accent}>{action.title}</Text>
        <Text dimColor>  {action.name}</Text>
        {action.annotations.destructive ? <Text color="red">  [destructive]</Text> : null}
      </Text>
      {mode === "form" ? <Text dimColor wrap="wrap">{mentions(action.description)}</Text> : null}
    </Box>
  );

  if(mode === "result" && outcome) {
    const unauthorized = !outcome.ok && outcome.code === "UNAUTHORIZED" && !session.auth?.token;
    return (
      <Box flexDirection="column" flexGrow={1}>
        {header}
        {outcome.ok ? (
          <Text><Text color="green" bold>✓ Done</Text><Text dimColor>  {Math.round(outcome.ms)}ms{Array.isArray(outcome.value) ? ` · ${outcome.value.length} items` : (outcome.value as { total?: number } | null)?.total !== undefined ? ` · ${(outcome.value as { total: number }).total} in all` : ""}</Text></Text>
        ) : (
          <ErrorBox title={outcome.code} message={outcome.message}>
            {unauthorized ? <Text dimColor>Not signed in. Log in from Account on the home screen{session.auth?.canLogIn ? ", or ⌃L on the actions list" : ""}.</Text> : null}
          </ErrorBox>
        )}
        {lines.length && (outcome.ok || outcome.data !== undefined) ? <Viewer lines={lines} width={width} height={Math.max(3, height - (outcome.ok ? 5 : 9))} /> : null}
        {flash ? <Text color="green">{flash}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {header}
      <Form fields={fields} values={values} onChange={setValues} onSubmit={submit} stickyKey={`action:${action.name}`} width={width} busy={mode === "running"} focus={mode === "form" || mode === "running"} />
      {!fields.length ? <Text dimColor>This action takes no input.</Text> : null}
      {problem ? <Text color="red">✗ {problem}</Text> : null}
      {mode === "confirm" ? (
        <Confirm danger message={`${action.title}?`} detail="This can lose data for good." yesLabel="Run it" onAnswer={yes => { if(yes) void run(); else setMode("form"); }} />
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>From the command line</Text>
        <Text color="cyan" wrap="wrap">{commandLine}</Text>
      </Box>
      {flash ? <Text color="green">{flash}</Text> : null}
    </Box>
  );
}
