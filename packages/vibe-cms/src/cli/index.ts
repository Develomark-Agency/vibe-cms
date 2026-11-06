#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { command, extendType, flag, number, option, optional, positional, run, string, subcommands } from "cmd-ts";
import pkg from "../../package.json" with { type: "json" };
import { actionCommands } from "./actions.ts";
import { exportCommand, importCommand } from "./backups.ts";
import { docs } from "./docs.ts";
import { locateBundle } from "./deploy/bundle.ts";
import { hubCommand } from "./hub.ts";
import { loginCommand, logoutCommand } from "./login.ts";

const Port = extendType(number, {
  displayName: "port",
  async from(port) {
    if(!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Expected a port between 1 and 65535, got ${port}`);
    return port;
  }
});

const Url = extendType(string, {
  displayName: "url",
  async from(value) {
    if(!URL.canParse(value)) throw new Error(`Expected a URL like http://localhost:1337, got "${value}"`);
    return value;
  }
});

const HexColor = extendType(string, {
  displayName: "#rrggbb",
  async from(value) {
    if(!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Expected a colour like #6d28d9, got "${value}"`);
    return value;
  }
});

const Text = extendType(string, { displayName: "text", from: async value => value });
const Path = extendType(string, { displayName: "path", from: async value => value });

const brand = `${styleText(["bold", "magenta"], "◆")} ${styleText("bold", "Vibe CMS")} ${styleText("dim", `v${pkg.version}`)}`;

const adminDev = command({
  name: "dev",
  description: "Run a local panel for development sites",
  args: {
    port: option({ long: "port", short: "p", type: Port, defaultValue: () => 5173, defaultValueIsSerializable: true, description: "Port to serve the panel on" }),
    site: option({ long: "site", type: optional(Url), description: "Open this site once the panel loads" }),
    name: option({ long: "name", type: optional(Text), description: "Your agency's name, shown in the panel" }),
    accent: option({ long: "accent", type: optional(HexColor), description: "Your agency's accent colour" }),
    icon: option({ long: "icon", type: optional(Text), description: "URL or path of your agency's logo" })
  },
  examples: [
    { description: "Open a local site in the panel", command: "vibe-cms admin --site http://localhost:1337" },
    { description: "White-label the panel", command: "vibe-cms admin --name Acme --accent #6d28d9" }
  ],
  async handler({ port, site, name, accent, icon }) {
    const [{ createServer, searchForWorkspaceRoot }, { default: react }, { default: tailwindcss }] = await Promise.all([
      import("vite"),
      import("@vitejs/plugin-react"),
      import("@tailwindcss/vite")
    ]);
    // The panel is built from source; `../../` is the package root from both src/cli and the published dist/cli.
    const root = fileURLToPath(new URL("../../src/panel/", import.meta.url));
    const server = await createServer({
      root,
      configFile: false,
      // Kept apart from the editor's caches, which sites keep in their own node_modules.
      cacheDir: path.join(process.cwd(), "node_modules", ".vibe-cms", "panel-vite"),
      plugins: [react(), tailwindcss()],
      define: { __VIBE_PANEL_BRANDING__: JSON.stringify({ name, accent, icon }) },
      // Dependencies (fonts, React) live in the workspace's node_modules, e.g. under node_modules/.bun.
      server: { port, fs: { allow: [path.resolve(root, "../.."), searchForWorkspaceRoot(root), searchForWorkspaceRoot(process.cwd())] } },
      appType: "spa",
      logLevel: "warn"
    });
    await server.listen();
    const url = `${server.resolvedUrls?.local[0] ?? `http://localhost:${port}/`}${site ? `?site=${encodeURIComponent(site)}` : ""}`;
    console.log(`\n  ${brand}  ${styleText("dim", "local panel")}\n`);
    console.log(`  ${styleText("green", "➜")}  ${styleText("bold", "Panel")}  ${styleText("cyan", url)}`);
    if(site) console.log(`  ${styleText("green", "➜")}  ${styleText("bold", "Site")}   ${styleText("cyan", site)}`);
    console.log(styleText("dim", "\n  Sites are kept in this browser. Development sites sign editors in without an identity provider.\n"));
  }
});

const adminDeploy = command({
  name: "deploy",
  description: "Deploy the agency panel to Cloudflare, step by step",
  args: {},
  examples: [{ description: "Set up, redeploy or find a panel", command: "vibe-cms admin deploy" }],
  async handler() {
    const [{ runWizard }, { clackPrompts }, { wranglerExec }] = await Promise.all([import("./deploy/wizard.ts"), import("./deploy/prompts.ts"), import("./deploy/cloudflare.ts")]);
    try {
      if(!process.stdin.isTTY) throw new Error("`vibe-cms admin deploy` asks questions, so it needs a terminal.");
      await runWizard({
        exec: wranglerExec,
        prompts: clackPrompts,
        bundle: await locateBundle(),
        setAccount: id => { process.env.CLOUDFLARE_ACCOUNT_ID = id; }
      });
    } catch (error) {
      console.error(`\n${styleText("red", "✗")} ${(error as Error).message}\n`);
      process.exit(1);
    }
  }
});

const adminAttach = command({
  name: "attach",
  description: "Attach a newly deployed site to your org's panel, from the claim link it logged",
  args: {
    link: positional({ type: string, displayName: "claim link or site", description: "The link a site without VIBE_ORG logs, ending in #claim=…, or just the site's address to fetch it" }),
    worker: option({ long: "worker", type: optional(Text), description: "With a site address: the Cloudflare Worker that serves it, if it can't be worked out" }),
    binding: option({ long: "binding", type: optional(Text), description: "With a site address: the D1 binding the CMS uses, if the Worker has several and none is called DB" }),
    hub: option({ long: "hub", type: optional(Text), description: "Your org's domain or the panel's URL, to log in first when this project has no login" }),
    template: option({ long: "template", type: optional(Text), description: "A role template's id, or \"none\" for no starting roles (default: the panel's default)" }),
    headless: flag({ long: "headless", description: "Don't open a browser to log in: print a link, and paste the code it shows" })
  },
  examples: [
    { description: "Attach a site once it's deployed", command: "vibe-cms admin attach \"https://client.com/_vibe/admin/#claim=…\"" },
    { description: "…or just give it the site's address, and it finds the link through Cloudflare", command: "vibe-cms admin attach https://client.com" },
    { description: "…logging in to the panel on the way", command: "vibe-cms admin attach \"…\" --hub my-agency.com" }
  ],
  async handler({ link, worker, binding, hub, template, headless }) {
    try {
      const { attach, describeAttached } = await import("./attach.ts");
      console.log(`\n${describeAttached(await attach({ link, worker, binding, hub, template, headless })).join("\n")}\n`);
    } catch (error) {
      console.error(`\n${styleText("red", "✗")} ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
});

const adminClaimLink = command({
  name: "claim-link",
  description: "Print a new site's claim link, for when you missed it in the site's logs",
  args: {
    site: positional({ type: string, displayName: "site", description: "The site's address, like https://client.com" }),
    worker: option({ long: "worker", type: optional(Text), description: "The Cloudflare Worker that serves the site, if it can't be worked out from the address" }),
    binding: option({ long: "binding", type: optional(Text), description: "The D1 binding the CMS uses, if the Worker has several and none is called DB" })
  },
  examples: [{ description: "Print the link, then hand it to the panel", command: "vibe-cms admin claim-link https://client.com" }],
  async handler({ site, worker, binding }) {
    try {
      const { claimLinkFor, connect } = await import("./claim.ts");
      console.log(await claimLinkFor(site, await connect(undefined, message => console.error(styleText("dim", `  ${message}`))), { worker, binding }));
    } catch (error) {
      console.error(`\n${styleText("red", "✗")} ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
});

const admin = subcommands({
  name: "admin",
  description: "The agency panel: run one locally, or deploy it",
  cmds: { dev: adminDev, deploy: adminDeploy, attach: adminAttach, "claim-link": adminClaimLink }
});

const buildAdminCommand = command({
  name: "build-admin",
  description: "Build the site's editor without the Vite plugin",
  args: {
    out: option({ long: "out", short: "o", type: Path, description: "Directory to write the editor to" }),
    config: option({ long: "config", short: "c", type: Path, defaultValue: () => "./vibe-cms.config.ts", defaultValueIsSerializable: true, description: "The site's config file" }),
    prefix: option({ long: "prefix", type: Path, defaultValue: () => "/_vibe", defaultValueIsSerializable: true, description: "Path the CMS is mounted at" }),
    root: option({ long: "root", type: optional(Path), description: "Site root, if not the current directory" })
  },
  examples: [{ description: "Build into the Worker's static assets", command: "vibe-cms build-admin --out dist/client/_vibe/admin" }],
  async handler({ out, config, prefix, root }) {
    const { buildAdmin } = await import("../vite/index.ts");
    const started = performance.now();
    await buildAdmin({ outDir: out, config, prefix, root });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`\n  ${styleText("green", "✓")} ${styleText("bold", "Editor built")} to ${styleText("cyan", out)} ${styleText("dim", `in ${seconds}s`)}\n`);
  }
});

await run(subcommands({
  name: "vibe-cms",
  version: pkg.version,
  description: "Guides, a local panel, build tools, and every CMS action against a running site",
  cmds: {
    docs,
    admin,
    "build-admin": buildAdminCommand,
    hub: hubCommand,
    login: loginCommand,
    logout: logoutCommand,
    export: exportCommand,
    import: importCommand,
    ...actionCommands()
  }
}), adminArgs(process.argv.slice(2)));

/** `vibe-cms admin --site …` is the local panel, as it was before `admin deploy`: it means `admin dev`. */
function adminArgs(args: string[]) {
  if(args[0] !== "admin") return args;
  const next = args[1];
  if(next === "dev" || next === "deploy" || next === "attach" || next === "claim-link" || next === "--help" || next === "-h" || next === "help") return args;
  return ["admin", "dev", ...args.slice(1)];
}
