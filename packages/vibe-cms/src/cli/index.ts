#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage = `vibe-cms <command>

Commands:
  admin [--port 5173] [--site <url>]   Run a local panel for development sites
  build-admin --out <dir> [--config ./vibe-cms.config.ts] [--prefix /_vibe]
                                       Build the site's editor without the Vite plugin
`;

const [command, ...rest] = process.argv.slice(2);

if(command === "admin") {
  const { values } = parseArgs({ args: rest, options: { port: { type: "string", default: "5173" }, site: { type: "string" } } });
  const [{ createServer, searchForWorkspaceRoot }, { default: react }, { default: tailwindcss }] = await Promise.all([
    import("vite"),
    import("@vitejs/plugin-react"),
    import("@tailwindcss/vite")
  ]);
  const root = fileURLToPath(new URL("../panel/", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    plugins: [react(), tailwindcss()],
    // Dependencies (fonts, React) live in the workspace's node_modules, e.g. under node_modules/.bun.
    server: { port: Number(values.port), fs: { allow: [path.resolve(root, "../.."), searchForWorkspaceRoot(root), searchForWorkspaceRoot(process.cwd())] } },
    appType: "spa",
    logLevel: "warn"
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? `http://localhost:${values.port}/`;
  console.log(`\n  vibe-cms local panel: ${url}${values.site ? `?site=${encodeURIComponent(values.site)}` : ""}\n`);
  console.log("  Sites are kept in this browser. Development sites sign editors in without an identity provider.\n");
} else if(command === "build-admin") {
  const { values } = parseArgs({
    args: rest,
    options: { out: { type: "string" }, config: { type: "string" }, prefix: { type: "string" }, root: { type: "string" } }
  });
  if(!values.out) {
    console.error(usage);
    process.exit(1);
  }
  const { buildAdmin } = await import("../vite/index.ts");
  await buildAdmin({ outDir: values.out, config: values.config, prefix: values.prefix, root: values.root });
  console.log(`vibe-cms: editor built to ${values.out}`);
} else {
  console.log(usage);
  process.exit(command ? 1 : 0);
}
