import { readFile } from "node:fs/promises";
import path from "node:path";
import { styleText } from "node:util";
import { array, command, flag, multioption, option, optional, positional, string, subcommands } from "cmd-ts";
import { isActionError } from "../actions/errors.ts";
import { coreActions } from "../actions/core.ts";
import { listActions, type ActionEntry } from "../actions/define.ts";
import { fromText, inputFields } from "../actions/inputs.ts";
import { httpCaller } from "../actions/client.ts";
import { CLI_CALLER } from "./caller.ts";
import { hubSiteToken, loginIfInteractive, siteLoginToken } from "./login.ts";

/**
 * The CLI surface: a command per action (`vibe-cms documents list --type post`),
 * its flags generated from the action's input, run against a site over HTTP.
 */

/** Action names in descriptions, as this surface spells them: `schema.get` → `schema get`. */
function mentions(text: string | undefined): string | undefined {
  return text?.replace(/`(\w+)\.(\w+)`/g, (_, group: string, verb: string) => `\`${group} ${kebab(verb)}\``);
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
}

export const connection = {
  site: option({ long: "site", env: "VIBE_SITE", type: string, description: "The site's URL, e.g. http://localhost:1337" }),
  token: option({ long: "token", env: "VIBE_TOKEN", type: optional(string), description: "A site session token. Without one: development sites sign you in, deployed ones use `vibe-cms login`" }),
  prefix: option({ long: "prefix", type: string, defaultValue: () => "/_vibe", defaultValueIsSerializable: true, description: "Path the CMS is mounted at" })
};

/** Development sites hand out a session to anyone, like the editor's dev sign-in. */
export async function devToken(site: string, prefix: string): Promise<string | undefined> {
  const response = await fetch(`${site.replace(/\/$/, "")}${prefix}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dev: true })
  }).catch(() => null);
  if(!response?.ok) return undefined;
  return (await response.json() as { token?: string }).token;
}

/**
 * `--token`, else a development sign-in, else your login to the site itself, else a session from this
 * project's hub login. At a terminal, a site that signs people in itself asks you to log in right then.
 */
export async function siteToken(values: { site: string, token?: string, prefix: string }): Promise<string | undefined> {
  const direct = values.token ?? await devToken(values.site, values.prefix) ?? await siteLoginToken(values.site, values.prefix);
  if(direct) return direct;
  let fromHub: string | undefined;
  try {
    fromHub = await hubSiteToken(values.site);
  } catch (error) {
    // The project's hub doesn't know this site: it may sign people in itself.
    const login = await loginIfInteractive(values.site, values.prefix);
    if(login) return login;
    throw error;
  }
  return fromHub ?? await loginIfInteractive(values.site, values.prefix);
}

/** `@path` reads a JSON value from a file. */
async function jsonArgument(value: string): Promise<string> {
  return value.startsWith("@") ? readFile(value.slice(1), "utf8") : value;
}

function actionCommand(action: ActionEntry) {
  const fields = inputFields(action.input);
  const args: Record<string, any> = { ...connection };
  for(const [key, info] of fields) {
    const description = info.kind === "file" ? "Path of the file" : [mentions(info.description), info.kind === "json" ? "JSON, or @file.json" : undefined].filter(Boolean).join("; ");
    const long = kebab(key);
    if(info.kind === "boolean") args[key] = flag({ long, description });
    else if(info.kind === "strings") args[key] = multioption({ long, type: array(string), description });
    else args[key] = option({ long, type: info.optional ? optional(string) : string, description });
  }
  return command({
    name: kebab(action.path.at(-1)!),
    description: `${action.title}. ${mentions(action.description)}`,
    args,
    async handler(values: Record<string, any>) {
      const text: Record<string, string | string[] | File> = {};
      for(const [key, info] of fields) {
        const value = values[key];
        if(value === undefined || value === false || (Array.isArray(value) && value.length === 0)) continue;
        if(info.kind === "boolean") text[key] = "true";
        else if(info.kind === "file") text[key] = new File([await readFile(value)], path.basename(value));
        else if(info.kind === "json") text[key] = await jsonArgument(value);
        else text[key] = value;
      }
      let token: string | undefined;
      try {
        token = await siteToken(values as { site: string, token?: string, prefix: string });
      } catch (error) {
        console.error(`${styleText("red", "✗")} ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const call = httpCaller({ url: values.site, prefix: values.prefix, token, ...CLI_CALLER });
      try {
        console.log(JSON.stringify(await call(action.name, fromText(action.input, text)), null, 2));
      } catch (error) {
        reportFailure(error, token);
      }
    }
  });
}

/** Prints an action's refusal and sets the exit code; anything else is a bug and throws. */
function reportFailure(error: unknown, token: string | undefined) {
  if(!isActionError(error)) throw error;
  console.error(`${styleText("red", "✗")} ${styleText("bold", error.code)} ${error.message}`);
  if(error.data !== undefined) console.error(styleText("dim", JSON.stringify(error.data, null, 2)));
  if(error.code === "UNAUTHORIZED" && !token) console.error(styleText("dim", "Log in with vibe-cms login <your org> (or --site <url> for a site without an org), or pass --token."));
  process.exitCode = 1;
}

/** `vibe-cms action seo.audit --input '{"type":"post"}'`: any action by name, including a plugin's, with its input as JSON. */
export const runActionCommand = command({
  name: "action",
  description: "Run any action by its name, as a plugin adds them (seo.audit). Built-in actions have commands of their own. `vibe-cms actions` lists what a site has.",
  args: {
    ...connection,
    name: positional({ type: string, displayName: "name", description: "The action's name, like seo.audit" }),
    input: option({ long: "input", short: "i", type: optional(string), description: "The input as JSON, or @file.json. Files go as { name, type?, base64 }" })
  },
  async handler(values) {
    let input: unknown = {};
    try {
      if(values.input) input = JSON.parse(await jsonArgument(values.input));
    } catch (error) {
      console.error(`${styleText("red", "✗")} --input isn't valid JSON: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
    let token: string | undefined;
    try {
      token = await siteToken(values);
    } catch (error) {
      console.error(`${styleText("red", "✗")} ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
    try {
      console.log(JSON.stringify(await httpCaller({ url: values.site, prefix: values.prefix, token, ...CLI_CALLER })(values.name, input), null, 2));
    } catch (error) {
      reportFailure(error, token);
    }
  }
});

/** `vibe-cms actions`: the site's actions, plugins' included, and whether agents get them as tools. */
export const listActionsCommand = command({
  name: "actions",
  description: "List a site's actions: built in and from its plugins, and which are MCP tools for agents",
  args: connection,
  async handler(values) {
    let token: string | undefined;
    try {
      token = await siteToken(values);
    } catch (error) {
      console.error(`${styleText("red", "✗")} ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const response = await fetch(`${values.site.replace(/\/$/, "")}${values.prefix}/api/actions`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if(!response.ok) {
      console.error(`${styleText("red", "✗")} The site answered ${response.status}`);
      process.exitCode = 1;
      return;
    }
    const { actions } = await response.json() as { actions: Array<{ name: string, title: string, mcp: boolean, plugin?: string }> };
    const width = Math.max(...actions.map(action => action.name.length));
    for(const action of actions) {
      console.log(`${action.name.padEnd(width)}  ${action.title}${action.mcp ? "" : styleText("dim", "  (not an MCP tool)")}`);
    }
  }
});

/** Subcommand groups (`documents`, `assets`, …), each with a command per action. */
export function actionCommands(actions: ActionEntry[] = listActions(coreActions)) {
  const groups = new Map<string, Record<string, ReturnType<typeof actionCommand>>>();
  for(const action of actions) {
    const group = action.path[0]!;
    if(!groups.has(group)) groups.set(group, {});
    groups.get(group)![kebab(action.path.at(-1)!)] = actionCommand(action);
  }
  return Object.fromEntries([...groups].map(([group, cmds]) => [group, subcommands({ name: group, description: `${group[0]!.toUpperCase()}${group.slice(1)} actions`, cmds })]));
}
