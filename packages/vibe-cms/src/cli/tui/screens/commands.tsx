import { Box, Text } from "ink";
import { useState } from "react";
import { useNav, useSession, type Session } from "../app.tsx";
import { checkValues, shellQuote, type Field, type FormValues } from "../fields.ts";
import { copy, useSticky } from "../system.ts";
import { accent, Form, useFlash, useHints, useKeys, useSize } from "../ui.tsx";

/**
 * Commands the TUI hands the terminal to, as they are: they open browsers, ask their own questions or
 * run until stopped. The form only gathers their flags.
 */
export interface TerminalCommand {
  id: string,
  section: string,
  label: string,
  title: string,
  description: string,
  /** Said before it runs, about what happens next. */
  note?: string,
  fields: Field[],
  defaults?: (session: Session) => FormValues,
  args: (values: FormValues, session: Session) => string[],
  submitLabel?: string
}

function text(value: FormValues[string]) {
  return typeof value === "string" ? value.trim() : "";
}
function option(flag: string, value: FormValues[string]) {
  return text(value) ? [flag, text(value)] : [];
}
function toggle(flag: string, value: FormValues[string]) {
  return value === true ? [flag] : [];
}

const definitions: TerminalCommand[] = [
  {
    id: "login-org",
    section: "Account",
    label: "Log in to your org",
    title: "Log in",
    description: "Log this project in to your org's hub, by the org's domain (its VIBE_ORG) or the hub's address. Every command then gets a session on the org's sites as you. The login lives in the OS keychain.",
    note: "Opens the hub in your browser to sign in and approve the CLI.",
    fields: [
      { key: "org", label: "Org", kind: "string", required: true, placeholder: "my-agency.com", description: "Your org's domain, or the hub's URL" },
      { key: "headless", label: "No browser", kind: "boolean", required: false, placeholder: "open a browser", description: "Print a link instead, and paste the code it shows" }
    ],
    args: v => ["login", text(v.org), ...toggle("--headless", v.headless)]
  },
  {
    id: "login-site",
    section: "Account",
    label: "Log in to a site",
    title: "Site login",
    description: "Log in to one site that signs people in itself (a site without an org). Site logins belong to the site, so every project can use them.",
    note: "Opens the site's editor in your browser to sign in and approve the CLI.",
    fields: [
      { key: "site", label: "Site", kind: "string", required: true, placeholder: "https://client.com", description: "The site's address" },
      { key: "prefix", label: "CMS path", kind: "string", required: false, placeholder: "/_vibe" },
      { key: "headless", label: "No browser", kind: "boolean", required: false, placeholder: "open a browser", description: "Print a link instead, and paste the code it shows" }
    ],
    defaults: s => ({ site: s.site?.url ?? "", prefix: s.site && s.site.prefix !== "/_vibe" ? s.site.prefix : "" }),
    args: v => ["login", "--site", text(v.site), ...option("--prefix", v.prefix), ...toggle("--headless", v.headless)]
  },
  {
    id: "logout",
    section: "Account",
    label: "Log out",
    title: "Log out",
    description: "Log out of this project's hub, or of one site, and revoke the login there.",
    fields: [
      { key: "site", label: "Site", kind: "string", required: false, placeholder: "empty: this project's hub", description: "A site you logged in to directly; leave it empty for the hub" },
      { key: "prefix", label: "CMS path", kind: "string", required: false, placeholder: "/_vibe" }
    ],
    args: v => ["logout", ...option("--site", v.site), ...text(v.site) ? option("--prefix", v.prefix) : []],
    submitLabel: "Log out"
  },
  {
    id: "panel-deploy",
    section: "Panel",
    label: "Deploy the agency panel",
    title: "Deploy panel",
    description: "A wizard that sets up, redeploys, reconfigures or finds your agency panel on Cloudflare, through your wrangler login. It asks everything first and creates nothing until you confirm the plan.",
    note: "The wizard asks its questions in the terminal.",
    fields: [],
    args: () => ["admin", "deploy"],
    submitLabel: "Start the wizard"
  },
  {
    id: "attach",
    section: "Panel",
    label: "Attach a new site",
    title: "Attach",
    description: "Give a newly deployed site (one without VIBE_ORG) to your org's panel, from its claim link or just its address. The panel tells the site its org, adds it, and makes you its owner.",
    fields: [
      { key: "link", label: "Link or site", kind: "string", required: true, placeholder: "https://client.com", description: "The claim link (…#claim=…), or the site's address to fetch it through Cloudflare" },
      { key: "hub", label: "Hub", kind: "string", required: false, placeholder: "my-agency.com", description: "Your org, to log in first when this project has no login" },
      { key: "template", label: "Roles", kind: "string", required: false, placeholder: "panel's default", description: "A role template's id, or none" },
      { key: "worker", label: "Worker", kind: "string", required: false, description: "With an address: the Worker that serves it, if it can't be worked out" },
      { key: "binding", label: "D1 binding", kind: "string", required: false, description: "With an address: the CMS's D1 binding, if the Worker has several and none is DB" },
      { key: "headless", label: "No browser", kind: "boolean", required: false, placeholder: "open a browser", description: "Log in without a browser: print a link, and paste the code" }
    ],
    defaults: s => ({ link: s.site && !/localhost|127\.0\.0\.1/.test(s.site.url) ? s.site.url : "" }),
    args: v => ["admin", "attach", text(v.link), ...option("--hub", v.hub), ...option("--template", v.template), ...option("--worker", v.worker), ...option("--binding", v.binding), ...toggle("--headless", v.headless)],
    submitLabel: "Attach"
  },
  {
    id: "build",
    section: "Tools",
    label: "Build the editor",
    title: "Build editor",
    description: "Build the site's editor without the Vite plugin, for a plain wrangler deploy.",
    fields: [
      { key: "out", label: "Out dir", kind: "string", required: true, placeholder: "dist/client/_vibe/admin", description: "Directory to write the editor to" },
      { key: "config", label: "Config", kind: "string", required: false, placeholder: "./vibe-cms.config.ts" },
      { key: "prefix", label: "CMS path", kind: "string", required: false, placeholder: "/_vibe" },
      { key: "root", label: "Site root", kind: "string", required: false, placeholder: "this directory" }
    ],
    args: v => ["build-admin", "--out", text(v.out), ...option("--config", v.config), ...option("--prefix", v.prefix), ...option("--root", v.root)],
    submitLabel: "Build"
  }
];

export const commands = definitions.map(command => ({ ...command, preview: (session: Session) => commandLine(command.args({ ...command.defaults?.(session) }, session)) }));

export function commandLine(args: string[]): string {
  return ["vibe-cms", ...args.filter(arg => arg !== "").map(shellQuote)].join(" ");
}

export function CommandScreen({ command }: { command: TerminalCommand }) {
  const session = useSession();
  const nav = useNav();
  const { width } = useSize();
  const [values, setValues] = useSticky<FormValues>(`command:${command.id}`, () => command.defaults?.(session) ?? {});
  const [last, setLast] = useState<number>();
  const [problem, setProblem] = useState<string>();
  const [flash, setFlash] = useFlash();
  const args = command.args(values, session);

  async function run() {
    const issue = checkValues(command.fields, values);
    if(issue) return setProblem(issue);
    setProblem(undefined);
    setLast(await session.runCommand(args));
  }

  useHints([
    ...command.fields.length ? [{ keys: "↑↓", label: "field" }] : [],
    { keys: "⌃R", label: "run" },
    { keys: "⌃Y", label: "copy command" },
    { keys: "esc", label: "back" }
  ]);
  useKeys((input, key) => {
    if(key.escape) nav.pop();
    else if(key.ctrl && input === "y") setFlash(copy(commandLine(args)));
  });

  return (
    <Box flexDirection="column">
      <Text bold color={accent}>{command.title}</Text>
      <Box marginBottom={1}><Text dimColor wrap="wrap">{command.description}</Text></Box>
      <Form fields={command.fields} values={values} onChange={v => { setValues(v); setProblem(undefined); }} onSubmit={() => void run()} stickyKey={`command:${command.id}`} width={width} submitLabel={command.submitLabel ?? "Run"} />
      {problem ? <Text color="red">✗ {problem}</Text> : null}
      {command.note ? <Text color="yellow">{command.note}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Runs</Text>
        <Text color="cyan" wrap="wrap">{commandLine(args)}</Text>
      </Box>
      {last !== undefined ? (
        <Box marginTop={1}>
          {last === 0 ? <Text color="green">✓ Finished</Text> : last === 130 ? <Text color="yellow">■ Stopped</Text> : <Text color="red">✗ Exited with {last}</Text>}
        </Box>
      ) : null}
      {flash ? <Text color="green">{flash}</Text> : null}
    </Box>
  );
}
