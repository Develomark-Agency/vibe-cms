import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { styleText } from "node:util";
import { useState } from "react";
import type { Site } from "./site.ts";

/** The TUI's own settings, next to the deploy wizard's: `$VIBE_CMS_HOME`, else `$XDG_CONFIG_HOME` or `~/.config`, then `vibe-cms`. */
function settingsFile(env = process.env): string {
  const home = env.VIBE_CMS_HOME || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "vibe-cms");
  return path.join(home, "tui.json");
}

interface Settings {
  /** Most recent first. Only addresses: tokens stay in the keychain. */
  sites: Site[]
}

export async function readSettings(): Promise<Settings> {
  try {
    const data = JSON.parse(await readFile(settingsFile(), "utf8")) as Partial<Settings>;
    return { sites: Array.isArray(data.sites) ? data.sites.filter(s => typeof s?.url === "string") : [] };
  } catch {
    return { sites: [] };
  }
}

/** Puts a site first in the recent list. A settings file that can't be written only costs the list. */
export async function rememberSite(site: Site): Promise<Site[]> {
  const settings = await readSettings();
  const known = settings.sites.find(s => s.url === site.url && s.prefix === site.prefix);
  const sites = [{ ...known, ...site }, ...settings.sites.filter(s => s !== known)].slice(0, 8);
  try {
    await mkdir(path.dirname(settingsFile()), { recursive: true });
    await writeFile(settingsFile(), `${JSON.stringify({ ...settings, sites }, null, 2)}\n`);
  } catch {}
  return sites;
}

/** Form values and the like that outlive the screen they're on, for the rest of the session. */
const sticky = new Map<string, unknown>();

export function useSticky<T>(key: string, initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => sticky.has(key) ? sticky.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial);
  return [value, next => setValue(current => {
    const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
    sticky.set(key, resolved);
    return resolved;
  })];
}

/**
 * Copies text: the platform's clipboard command, else OSC 52, which most terminals (and tmux, and SSH
 * sessions) pass to the local clipboard.
 */
export function copy(text: string): string {
  const command = process.platform === "darwin" ? ["pbcopy"] : process.platform === "win32" ? ["clip"] : process.env.WAYLAND_DISPLAY ? ["wl-copy"] : ["xclip", "-selection", "clipboard"];
  const result = spawnSync(command[0]!, command.slice(1), { input: text, stdio: ["pipe", "ignore", "ignore"] });
  if(!result.error && result.status === 0) return "Copied";
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  return "Copied (through the terminal)";
}

/** How to run this same CLI again: the runtime, its flags, and the script. */
function self(): [string, string[]] {
  return [process.execPath, [...process.execArgv, process.argv[1]!]];
}

/**
 * Waits for Enter (or Esc, or q) on a terminal Ink has let go of. Reads the way Ink does, through
 * `readable`: a `data` listener would switch stdin to flowing mode, and Ink would hear nothing after.
 */
function waitForKey(): Promise<void> {
  return new Promise(resolve => {
    const stdin = process.stdin;
    if(!stdin.isTTY) return resolve();
    stdin.setRawMode(true);
    function onReadable() {
      let chunk: string | Buffer | null;
      while((chunk = stdin.read()) !== null) {
        const key = chunk.toString();
        if(key === "\r" || key === "\n" || key === "\x1b" || key === "q" || key === "\x03") {
          stdin.off("readable", onReadable);
          stdin.setRawMode(false);
          resolve();
          return;
        }
      }
    }
    stdin.on("readable", onReadable);
  });
}

/**
 * Runs `vibe-cms <args>` in the terminal itself, for what a TUI shouldn't wrap: a wizard with its own
 * prompts, a browser login, a server that runs until Ctrl+C. The caller suspends Ink around it.
 */
export async function runInTerminal(args: string[], options: { pause?: boolean } = {}): Promise<number> {
  const [runtime, prefix] = self();
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`${styleText("dim", "$")} ${styleText("bold", ["vibe-cms", ...args].map(arg => /^[\w@%+=:,./#-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`).join(" "))}\n\n`);
  // Ctrl+C belongs to the command (stopping a server, say), not to the TUI waiting for it.
  function ignore() {}
  process.on("SIGINT", ignore);
  try {
    const code = await new Promise<number>(resolve => {
      const child = spawn(runtime, [...prefix, ...args], { stdio: "inherit", env: process.env });
      child.on("error", () => resolve(1));
      child.on("close", (status, signal) => resolve(status ?? (signal === "SIGINT" ? 130 : 1)));
    });
    if(options.pause !== false) {
      const status = code === 0 ? styleText("green", "✓ Done") : code === 130 ? styleText("yellow", "■ Stopped") : styleText("red", `✗ Exited with ${code}`);
      process.stdout.write(`\n${status}  ${styleText("dim", "Press Enter to go back to Vibe CMS")}`);
      await waitForKey();
    }
    return code;
  } finally {
    process.off("SIGINT", ignore);
  }
}
