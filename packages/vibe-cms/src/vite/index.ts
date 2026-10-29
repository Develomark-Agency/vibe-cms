import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { init as initLexer, parse as parseExports } from "es-module-lexer";
import { build, createServer, runnerImport, searchForWorkspaceRoot, type Connect, type Plugin, type ViteDevServer } from "vite";
import type { AnyConfig } from "../config.ts";
import { collectDescriptors } from "../descriptor.ts";

export interface VibeOptions {
  /** Path to the config, relative to the Vite root. Defaults to `./vibe-cms.config.ts`. */
  config?: string,
  /**
   * Your own Worker entry (e.g. `./src/worker.ts`), for frameworks whose
   * deploy tooling pins the server entry (Alchemy 2's Astro resource). Their
   * entry is redirected to yours, which wraps it with `vibe({...})`.
   */
  entry?: string
}

/** Server entry modules that tools pin and `entry` replaces. */
const PINNED_ENTRIES = [
  "@astrojs/cloudflare/entrypoints/server",
  "@alchemy.run/frontend-frameworks/astro/entrypoints/server"
];

function entryPlugin(entry: string): Plugin {
  let file = entry;
  return {
    name: "vibe-cms:worker-entry",
    enforce: "pre",
    configResolved(config) {
      file = path.resolve(config.root, entry);
    },
    resolveId(id, importer) {
      // Your entry imports the framework's own; only redirect everyone else.
      if(PINNED_ENTRIES.includes(id) && importer !== file) return file;
      return null;
    }
  };
}

const EXPORTS_ID = "\0vibe-cms:exports";
const ADMIN_ROOT = fileURLToPath(new URL("../admin/app/", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ADMIN_FILE = /\.admin\.[cm]?[jt]sx?(\?|$)/;
const SERVER_FILE = /\.server\.[cm]?[jt]sx?(\?|$)/;

/**
 * Replaces a module with one exporting the same names as `undefined`, so
 * `export { X } from "./thing.server"` still links in the other runtime.
 */
async function stubFor(code: string): Promise<string> {
  await initLexer;
  let names: string[] = [];
  try {
    names = parseExports(code)[1].flatMap(e => ("name" in e ? [e.name] : []));
  } catch {
    names = [...code.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([\w$]+)/g)].map(m => m[1]!);
    if(/export\s+default/.test(code)) names.push("default");
  }
  const lines = ["// Stubbed by vibe-cms: this module belongs to another runtime."];
  for(const name of new Set(names)) {
    lines.push(name === "default" ? "export default undefined;" : `export const ${name} = undefined;`);
  }
  return lines.join("\n");
}

/** `.admin` files are stubbed everywhere except the editor; `.server` files only in browser code. */
function stubPlugin(stub: (id: string, environment: string) => boolean): Plugin {
  return {
    name: "vibe-cms:stub",
    enforce: "post",
    async transform(code, id) {
      if(!stub(id, this.environment?.name ?? "client")) return null;
      return { code: await stubFor(code), map: null };
    }
  };
}

async function loadConfig(file: string, root: string): Promise<AnyConfig> {
  const { module } = await runnerImport<{ default: AnyConfig }>(file, {
    root,
    configFile: false,
    logLevel: "error",
    // Only descriptors are needed here, so neither runtime's code is loaded.
    plugins: [stubPlugin(id => ADMIN_FILE.test(id) || SERVER_FILE.test(id))]
  });
  return module.default;
}

/** `export { SessionDO } from "@acme/search"` for every plugin that declares worker classes. */
async function exportsModule(configFile: string, root: string): Promise<string> {
  const config = await loadConfig(configFile, root);
  const lines: string[] = [];
  for(const plugin of collectDescriptors(config).plugins) {
    if(!plugin.exports?.names.length) continue;
    const from = plugin.exports.from.startsWith("file:") ? fileURLToPath(plugin.exports.from) : plugin.exports.from;
    lines.push(`export { ${plugin.exports.names.join(", ")} } from ${JSON.stringify(from)};`);
  }
  return lines.length ? lines.join("\n") : "export {};";
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * The editor's stylesheet: the admin core's styles plus the project as a
 * Tailwind source, so site widgets can use utility classes. Written to the
 * cache directory, never to your source tree.
 */
async function writeAdminCss(root: string): Promise<string> {
  const dir = path.join(root, "node_modules", ".vibe-cms");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "admin.css");
  const sources = [root, ...await widgetPackages(root)];
  const css = [
    `@import ${JSON.stringify(path.join(ADMIN_ROOT, "styles.css"))};`,
    ...sources.map(source => `@source ${JSON.stringify(source)};`),
    `@source not ${JSON.stringify(path.join(root, "dist"))};`,
    ""
  ].join("\n");
  const existing = existsSync(file) ? await readFile(file, "utf8") : "";
  if(existing !== css) await writeFile(file, css);
  return file;
}

/** Installed packages built on vibe-cms (widgets, plugins) are Tailwind sources too. */
async function widgetPackages(root: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const out: string[] = [];
    for(const name of names) {
      if(name === "vibe-cms") continue;
      const dir = path.join(root, "node_modules", name);
      try {
        const dep = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
        if({ ...dep.dependencies, ...dep.peerDependencies }["vibe-cms"]) out.push(dir);
      } catch {
        // Not installed (yet).
      }
    }
    return out;
  } catch {
    return [];
  }
}

function adminViteConfig(root: string, configFile: string, base: string, cssFile: string) {
  return {
    root: ADMIN_ROOT,
    base,
    configFile: false as const,
    envDir: root,
    logLevel: "warn" as const,
    appType: "custom" as const,
    resolve: { dedupe: ["react", "react-dom", "@tanstack/react-query", "@base-ui/react"] },
    server: { fs: { allow: [searchForWorkspaceRoot(root), root, PACKAGE_ROOT] } },
    optimizeDeps: { entries: [path.join(ADMIN_ROOT, "entry.ts")], include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [
      react(),
      tailwindcss(),
      stubPlugin(id => SERVER_FILE.test(id)),
      {
        name: "vibe-cms:admin-entry",
        resolveId(id: string) {
          if(id === "virtual:vibe/config") return path.resolve(root, configFile);
          if(id === "virtual:vibe/admin.css") return cssFile;
          return null;
        }
      } satisfies Plugin
    ]
  };
}

function serveAdmin(parent: ViteDevServer, root: string, configFile: string, base: string): Connect.NextHandleFunction {
  let child: Promise<ViteDevServer> | undefined;
  async function start() {
    const cssFile = await writeAdminCss(root);
    const hmr = parent.httpServer ? { server: parent.httpServer } : { port: await freePort() };
    const server = await createServer({
      ...adminViteConfig(root, configFile, base, cssFile),
      server: { ...adminViteConfig(root, configFile, base, cssFile).server, middlewareMode: true, hmr }
    });
    parent.httpServer?.once("close", () => void server.close());
    return server;
  }
  return async (req, res, next) => {
    const url = req.url ?? "/";
    if(url === base.slice(0, -1) || url.startsWith(`${base.slice(0, -1)}?`)) {
      res.writeHead(302, { location: base + url.slice(base.length - 1) });
      res.end();
      return;
    }
    if(!url.startsWith(base)) return next();
    try {
      child ??= start();
      const server = await child;
      const pathname = url.split("?")[0]!;
      const isPage = req.method === "GET" && !/\.\w+$/.test(pathname) && !pathname.includes("/@") && !pathname.includes("/node_modules/")
        && (req.headers.accept ?? "").includes("text/html");
      if(isPage) {
        const template = await readFile(path.join(ADMIN_ROOT, "index.html"), "utf8");
        const html = await server.transformIndexHtml(url, template);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        res.end(html);
        return;
      }
      server.middlewares(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

export function vibe(options: VibeOptions = {}): Plugin[] {
  const configFile = options.config ?? "./vibe-cms.config.ts";
  let root = process.cwd();
  let prefix = "/_vibe";
  let built = false;

  async function readPrefix() {
    try {
      prefix = ((await loadConfig(path.resolve(root, configFile), root)).prefix ?? "/_vibe").replace(/\/$/, "");
    } catch (error) {
      console.warn(`vibe-cms: couldn't load ${configFile}:`, (error as Error).message);
    }
  }

  return [
    {
      name: "vibe-cms",
      enforce: "pre",
      configResolved(config) {
        root = config.root;
      },
      resolveId(id) {
        if(id === "vibe-cms/exports") return EXPORTS_ID;
        return null;
      },
      load(id) {
        if(id === EXPORTS_ID) return exportsModule(path.resolve(root, configFile), root);
        return null;
      },
      async configureServer(server) {
        await readPrefix();
        server.middlewares.use(serveAdmin(server, root, configFile, `${prefix}/admin/`));
      }
    },
    ...(options.entry ? [entryPlugin(options.entry)] : []),
    stubPlugin((id, environment) => ADMIN_FILE.test(id) || (environment === "client" && SERVER_FILE.test(id))),
    {
      name: "vibe-cms:admin-build",
      apply: "build",
      applyToEnvironment: environment => environment.name === "client",
      async writeBundle() {
        if(built) return;
        built = true;
        await readPrefix();
        const outDir = path.resolve(root, this.environment.config.build.outDir, `.${prefix}/admin`);
        const cssFile = await writeAdminCss(root);
        await build({
          ...adminViteConfig(root, configFile, `${prefix}/admin/`, cssFile),
          logLevel: "warn",
          build: { outDir, emptyOutDir: true, assetsDir: "assets", chunkSizeWarningLimit: 2000 }
        });
        this.environment.logger.info(`vibe-cms: editor built to ${path.relative(root, outDir)}`);
      }
    }
  ];
}

/** Builds the editor without a Vite-based site build, e.g. for plain `wrangler deploy`. */
export async function buildAdmin(options: { root?: string, config?: string, outDir: string, prefix?: string }) {
  const root = path.resolve(options.root ?? process.cwd());
  const configFile = options.config ?? "./vibe-cms.config.ts";
  const prefix = options.prefix ?? "/_vibe";
  const cssFile = await writeAdminCss(root);
  await build({
    ...adminViteConfig(root, configFile, `${prefix}/admin/`, cssFile),
    build: { outDir: path.resolve(root, options.outDir), emptyOutDir: true, chunkSizeWarningLimit: 2000 }
  });
}

export default vibe;
