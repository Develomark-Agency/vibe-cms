import { spawn, type ChildProcess } from "node:child_process";

/**
 * The local panel (`vibe-cms admin dev`) run in the background while the TUI carries on, and stopped
 * with it. Its output is kept for the panel screen rather than shown.
 */

export interface PanelOptions {
  port?: string,
  site?: string,
  name?: string,
  accent?: string,
  icon?: string
}

export interface PanelState {
  status: "stopped" | "starting" | "running" | "failed",
  /** Where it's serving, as it said: Vite moves to the next port when the one asked for is taken. */
  url?: string,
  /** The last lines it printed. */
  log: string[],
  /** How it ended, when it ended by itself. */
  error?: string
}

/** The command's flags for these options. */
export function panelArgs(options: PanelOptions): string[] {
  const args = ["admin", "dev"];
  for(const key of ["port", "site", "name", "accent", "icon"] as const) {
    const value = options[key]?.trim();
    if(value) args.push(`--${key}`, value);
  }
  return args;
}

const running = new Set<ChildProcess>();

function kill(child: ChildProcess) {
  if(child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Its own process group, so Vite's helpers go too.
    if(process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill();
  } catch {
    child.kill();
  }
}

/** Stops every panel this TUI started. Runs on the way out, however the TUI ends. */
export function stopAllPanels() {
  for(const child of running) kill(child);
}

process.on("exit", stopAllPanels);

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Starts the panel; `onChange` hears every change of state. */
export function startPanel(options: PanelOptions, onChange: (state: PanelState) => void): { stop(): void } {
  let state: PanelState = { status: "starting", log: [] };
  function update(next: Partial<PanelState>) {
    state = { ...state, ...next };
    onChange(state);
  }
  update({});
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...panelArgs(options)], {
    // A process group of its own: Ctrl+C in a command the TUI hands the terminal to doesn't reach it.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", VIBE_CMS_EXIT_WITH_PARENT: "1" }
  });
  running.add(child);
  let stopping = false;
  function take(chunk: Buffer) {
    const lines = chunk.toString().replace(ANSI, "").split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
    if(!lines.length) return;
    const url = lines.map(line => /Panel\s+(https?:\/\/\S+)/.exec(line)?.[1]).find(Boolean);
    update({ log: [...state.log, ...lines].slice(-40), ...url ? { url, status: "running" } : {} });
  }
  child.stdout!.on("data", take);
  child.stderr!.on("data", take);
  child.on("error", error => update({ status: "failed", error: error.message }));
  child.on("exit", (code, signal) => {
    running.delete(child);
    if(stopping || signal === "SIGTERM") update({ status: "stopped", url: undefined });
    else update({ status: "failed", url: undefined, error: `It stopped by itself (${signal ?? `exit ${code}`}).` });
  });
  return {
    stop() {
      stopping = true;
      kill(child);
    }
  };
}
