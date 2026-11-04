import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHandler } from "../src/handler/index.ts";
import { config } from "./fixture.ts";
import { createD1, createR2, ctx, png } from "./helpers.ts";

const env = { DB: createD1(), MEDIA: createR2() };
const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA }) });
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: request => vibe.handle(request, env, ctx) });
});

afterAll(() => server.stop(true));

async function cli(...args: string[]) {
  return run(process.cwd(), ...args);
}

async function run(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "../src/cli/index.ts"), ...args, "--site", server.url.origin], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let json: any;
  try {
    json = code === 0 ? JSON.parse(stdout) : undefined;
  } catch {}
  return { code, stdout, stderr, json };
}

describe("cli", () => {
  test("runs actions against a site, with flags from their inputs", async () => {
    const created = await cli("documents", "create", "--type", "author", "--data", "{\"name\":\"Ada\"}", "--publish");
    expect(created.code).toBe(0);
    expect(created.json.status).toBe("published");
    const listed = await cli("documents", "list", "--type", "author", "--limit", "5");
    expect(listed.json.total).toBe(1);
  }, 20_000);

  test("uploads files from a path and reads JSON from @files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vibe-cli-"));
    await writeFile(path.join(dir, "pic.png"), png(30, 20));
    const uploaded = await cli("assets", "upload", "--file", path.join(dir, "pic.png"), "--folder", "cli");
    expect(uploaded.json.meta).toEqual({ width: 30, height: 20 });
    expect(uploaded.json.folder).toBe("cli");
    await writeFile(path.join(dir, "author.json"), JSON.stringify({ name: "Grace" }));
    const created = await cli("documents", "create", "--type", "author", "--data", `@${path.join(dir, "author.json")}`);
    expect(created.json.draft).toEqual({ name: "Grace" });
  }, 20_000);

  test("failures print the code and exit non-zero", async () => {
    const failed = await cli("documents", "get", "--type", "author", "--id", "nope");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("NOT_FOUND");
  }, 20_000);

  test("exports a site to one .vibe file and imports it back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vibe-cli-"));
    await cli("documents", "create", "--type", "author", "--data", "{\"name\":\"Kept\"}", "--publish");
    const exported = await run(dir, "export", "--file", "site.vibe");
    expect(exported.code).toBe(0);
    expect(exported.stdout).toContain("Exported site.vibe");
    const before = (await cli("documents", "list", "--type", "author")).json.total;
    await cli("documents", "create", "--type", "author", "--data", "{\"name\":\"Added later\"}", "--publish");

    const dry = await run(dir, "import", "site.vibe", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/documents\s+\d+ → \d+/);
    const imported = await run(dir, "import", "site.vibe", "--yes");
    expect(imported.code).toBe(0);
    expect(imported.stdout).toContain("Imported");
    expect((await cli("documents", "list", "--type", "author")).json.total).toBe(before);
    // The site as it was before the import, next to the file.
    expect((await readdir(dir)).some(name => name.includes("-before-import-") && name.endsWith(".vibe"))).toBe(true);

    const missing = await run(dir, "import", "nope.vibe", "--yes");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("No file at nope.vibe");
  }, 30_000);
});
