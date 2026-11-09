import { render } from "ink";
import { App } from "./app.tsx";
import { Home } from "./screens/home.tsx";
import { normalizePrefix, normalizeSite } from "./site.ts";

/**
 * `vibe-cms` on its own, at a terminal: the whole CLI as screens to move through. Everything here is
 * also a command (`vibe-cms --help`), and each screen shows the command it amounts to.
 */
export async function runTui(version: string) {
  const url = process.env.VIBE_SITE ? normalizeSite(process.env.VIBE_SITE) : null;
  const instance = render(<App version={version} home={() => <Home />} initialSite={url ? { url, prefix: normalizePrefix(undefined) } : undefined} />, {
    alternateScreen: true,
    exitOnCtrlC: true,
    patchConsole: true
  });
  await instance.waitUntilExit();
}
