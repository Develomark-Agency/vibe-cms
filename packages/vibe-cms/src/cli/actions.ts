import { readFile } from "node:fs/promises";
import path from "node:path";
import { styleText } from "node:util";
import { array, command, flag, multioption, option, optional, string, subcommands } from "cmd-ts";
import { coreActions } from "../actions/core.ts";
import type { AnyAction } from "../actions/define.ts";
import { fromText, inputFields } from "../actions/inputs.ts";
import { httpCaller } from "../actions/client.ts";

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

const connection = {
  site: option({ long: "site", env: "VIBE_SITE", type: string, description: "The site's URL, e.g. http://localhost:1337" }),
  token: option({ long: "token", env: "VIBE_TOKEN", type: optional(string), description: "A site session token; development sites sign you in without one" }),
  prefix: option({ long: "prefix", type: string, defaultValue: () => "/_vibe", defaultValueIsSerializable: true, description: "Path the CMS is mounted at" })
};

/** Development sites hand out a session to anyone, like the editor's dev sign-in. */
async function devToken(site: string, prefix: string): Promise<string | undefined> {
  const response = await fetch(`${site.replace(/\/$/, "")}${prefix}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dev: true })
  }).catch(() => null);
  if(!response?.ok) return undefined;
  return (await response.json() as { token?: string }).token;
}

/** `@path` reads a JSON value from a file. */
async function jsonArgument(value: string): Promise<string> {
  return value.startsWith("@") ? readFile(value.slice(1), "utf8") : value;
}

function actionCommand(action: AnyAction) {
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
    name: kebab(action.name.split(".")[1]!),
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
      const token = values.token ?? await devToken(values.site, values.prefix);
      const call = httpCaller({ url: values.site, prefix: values.prefix, token });
      const result = await call(action.name, fromText(action.input, text));
      if(result.isOk()) {
        console.log(JSON.stringify(result.value, null, 2));
        return;
      }
      const error = result.error;
      console.error(`${styleText("red", "✗")} ${styleText("bold", error._tag)} ${error.message}`);
      if(error.details !== undefined) console.error(styleText("dim", JSON.stringify(error.details, null, 2)));
      if(error._tag === "Unauthorized" && !values.token) console.error(styleText("dim", "Pass --token or set VIBE_TOKEN."));
      process.exitCode = 1;
    }
  });
}

/** Subcommand groups (`documents`, `assets`, …), each with a command per action. */
export function actionCommands(actions: Record<string, AnyAction> = coreActions) {
  const groups = new Map<string, Record<string, ReturnType<typeof actionCommand>>>();
  for(const action of Object.values(actions)) {
    const [group, verb] = action.name.split(".") as [string, string];
    if(!groups.has(group)) groups.set(group, {});
    groups.get(group)![kebab(verb)] = actionCommand(action);
  }
  return Object.fromEntries([...groups].map(([group, cmds]) => [group, subcommands({ name: group, description: `${group[0]!.toUpperCase()}${group.slice(1)} actions`, cmds })]));
}
