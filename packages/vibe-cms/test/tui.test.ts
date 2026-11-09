import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { coreActions } from "../src/actions/core.ts";
import { listActions } from "../src/actions/define.ts";
import { describeActions } from "../src/actions/describe.ts";
import { loadTopics } from "../src/cli/docs.ts";
import { onePerSite, parseAddress, parseParents, parseLsof, parseNetstat, parseSs, probe } from "../src/cli/tui/discover.ts";
import { actionCommandLine, checkValues, fieldsFromSchema, toInput } from "../src/cli/tui/fields.ts";
import { panelArgs } from "../src/cli/tui/panel.ts";
import { normalizePrefix, normalizeSite } from "../src/cli/tui/site.ts";
import { markdownLines, wrapLine } from "../src/cli/tui/text.ts";

const actions = describeActions(listActions(coreActions));
function action(name: string) {
  return actions.find(a => a.name === name)!;
}
const site = { url: "http://localhost:1337", prefix: "/_vibe" };

describe("tui forms", () => {
  test("read every built-in action's input as fields", () => {
    for(const a of actions) expect(() => fieldsFromSchema(a.input)).not.toThrow();
    const create = Object.fromEntries(fieldsFromSchema(action("documents.create").input).map(f => [f.key, f]));
    expect(create.type).toMatchObject({ kind: "string", required: true });
    expect(create.data!.kind).toBe("json");
    expect(create.publish!.kind).toBe("boolean");
    expect(Object.fromEntries(fieldsFromSchema(action("assets.upload").input).map(f => [f.key, f.kind])).file).toBe("file");
    expect(fieldsFromSchema(action("documents.schedule").input).find(f => f.key === "action")).toMatchObject({ kind: "enum", options: ["publish", "unpublish"] });
    // `["string", "null"]` and `anyOf: [X, null]` are both nullable strings.
    expect(fieldsFromSchema(action("site.update").input).find(f => f.key === "accent")).toMatchObject({ kind: "string", nullable: true });
    expect(fieldsFromSchema(action("assets.update").input).find(f => f.key === "folder")).toMatchObject({ kind: "string", nullable: true });
    expect(fieldsFromSchema(action("assets.list").input).find(f => f.key === "accept")!.kind).toBe("strings");
  });

  test("turn typed values into the action's input", async () => {
    const fields = fieldsFromSchema(action("documents.list").input);
    expect(await toInput(fields, { type: "post", limit: "5", search: "" })).toEqual({ type: "post", limit: 5 });
    const update = fieldsFromSchema(action("site.update").input);
    expect(await toInput(update, { accent: "null", stripMetadata: false })).toEqual({ accent: null, stripMetadata: false });
    const assets = fieldsFromSchema(action("assets.list").input);
    expect(await toInput(assets, { accept: "image/*, video/*" })).toEqual({ accept: ["image/*", "video/*"] });
  });

  test("read JSON and files from paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vibe-tui-"));
    await writeFile(path.join(dir, "data.json"), "{\"title\":\"From a file\"}");
    await writeFile(path.join(dir, "pic.txt"), "hello");
    const create = fieldsFromSchema(action("documents.create").input);
    expect((await toInput(create, { type: "post", data: `@${path.join(dir, "data.json")}` })).data).toEqual({ title: "From a file" });
    const upload = await toInput(fieldsFromSchema(action("assets.upload").input), { file: path.join(dir, "pic.txt") });
    expect(upload.file).toBeInstanceOf(File);
    expect((upload.file as File).name).toBe("pic.txt");
  });

  test("say what's missing or malformed before sending", async () => {
    const create = fieldsFromSchema(action("documents.create").input);
    expect(checkValues(create, { data: "{}" })).toBe("type is required");
    expect(checkValues(create, { type: "post", data: "{nope" })).toContain("isn't valid JSON");
    await expect(toInput(create, { data: "{}" })).rejects.toThrow("type is required");
  });

  test("show the same thing as a CLI command", () => {
    const create = action("documents.create");
    expect(actionCommandLine(create, fieldsFromSchema(create.input), { type: "post", data: "{\"title\":\"Hi there\"}", publish: true }, site))
      .toBe("vibe-cms documents create --type post --data '{\"title\":\"Hi there\"}' --publish --site http://localhost:1337");
    const restore = action("documents.restoreVersion");
    expect(actionCommandLine(restore, fieldsFromSchema(restore.input), { type: "post", id: "doc_1", ver: "2" })).toBe("vibe-cms documents restore-version --type post --id doc_1 --ver 2");
    const plugin = { name: "seo.audit", plugin: "seo" };
    expect(actionCommandLine(plugin, fieldsFromSchema({ type: "object", properties: { limit: { type: "integer" } } }), { limit: "3" }, { url: "https://x.com", prefix: "/cms" }))
      .toBe("vibe-cms action seo.audit --input '{\"limit\":3}' --site https://x.com --prefix /cms");
  });
});

describe("tui sites", () => {
  test("take addresses the way people type them", () => {
    expect(normalizeSite("localhost:1337")).toBe("http://localhost:1337");
    expect(normalizeSite("client.com/")).toBe("https://client.com");
    expect(normalizeSite("blog.test")).toBe("http://blog.test");
    expect(normalizeSite("http://client.com/_vibe/admin")).toBe("http://client.com");
    expect(normalizeSite("  ")).toBeNull();
    expect(normalizePrefix("cms/")).toBe("/cms");
    expect(normalizePrefix("")).toBe("/_vibe");
  });
});

describe("tui text", () => {
  test("wraps between words, keeping styles and indent", () => {
    const rows = wrapLine([{ text: "  one two " }, { text: "three", color: "cyan" }, { text: " four five" }], 12);
    expect(rows.map(row => row.map(s => s.text).join(""))).toEqual(["  one two ", "  three four", "  five"]);
    expect(rows[1]![1]).toMatchObject({ text: "three", color: "cyan" });
    expect(wrapLine([{ text: "x".repeat(25) }], 10).map(r => r.map(s => s.text).join(""))).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  test("renders every guide one line per source line, so search hits can be scrolled to", async () => {
    for(const topic of await loadTopics()) expect(markdownLines(topic.body).length).toBe(topic.body.split("\n").length);
  });
});

describe("tui local sites", () => {
  test("read listening ports from lsof, ss and netstat", () => {
    expect(parseAddress("127.0.0.1:1340")).toEqual({ host: "localhost", port: 1340 });
    expect(parseAddress("*:5173")).toEqual({ host: "localhost", port: 5173 });
    expect(parseAddress("[::1]:8787")).toEqual({ host: "localhost", port: 8787 });
    expect(parseAddress("192.168.1.4:3000")).toEqual({ host: "192.168.1.4", port: 3000 });
    expect(parseAddress("[fe80::1%en0]:3000")).toEqual({ host: "[fe80::1]", port: 3000 });
    expect(parseAddress("nonsense")).toBeNull();
    expect(parseLsof("p123\ncnode\nf21\nn127.0.0.1:1340\nn[::1]:1340\np456\ncworkerd\nn*:8787\n")).toEqual([
      { host: "localhost", port: 1340, pid: 123, command: "node" },
      { host: "localhost", port: 1340, pid: 123, command: "node" },
      { host: "localhost", port: 8787, pid: 456, command: "workerd" }
    ]);
    expect(parseSs("LISTEN 0 511 127.0.0.1:4321 0.0.0.0:* users:((\"node\",pid=99,fd=21))\nLISTEN 0 4096 [::]:22 [::]:*\n")).toEqual([
      { host: "localhost", port: 4321, pid: 99, command: "node" },
      { host: "localhost", port: 22, pid: undefined, command: undefined }
    ]);
    expect(parseNetstat("  Proto  Local Address  Foreign Address  State  PID\n  TCP    0.0.0.0:1337   0.0.0.0:0   LISTENING   4242\n  TCP    127.0.0.1:5000   127.0.0.1:6000   ESTABLISHED   1\n")).toEqual([
      { host: "localhost", port: 1337, pid: 4242 }
    ]);
  });

  test("know a site by its descriptor, with its CMS path and whether it's in dev mode", async () => {
    const fake = (async (url: string) => {
      if(url === "http://localhost:4321/.well-known/vibe-cms") return Response.json({ protocol: 1, name: "Blog", admin: "http://localhost:4321/cms/admin" });
      if(url === "http://localhost:4321/cms/api/info") return Response.json({ dev: true });
      if(url === "http://localhost:3000/.well-known/vibe-cms") return new Response("<h1>Next.js</h1>", { headers: { "content-type": "text/html" } });
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await probe({ host: "localhost", port: 4321 }, fake)).toEqual({ url: "http://localhost:4321", prefix: "/cms", name: "Blog", dev: true, command: undefined });
    expect(await probe({ host: "localhost", port: 3000 }, fake)).toBeNull();
    expect(await probe({ host: "localhost", port: 9 }, fake)).toBeNull();
  });

  test("list a server once: workerd behind a dev server goes, unrelated servers of the same site stay", () => {
    const site = { id: "site_1", prefix: "/_vibe", name: "CT Moving", dev: true };
    // astro (100) → workerd (101, via 120); a second checkout (200) on the same database; another site (300).
    const parents = parseParents("  100   1\n  120 100\n  101 120\n  200   1\n  300   1\n");
    function urls(sites: Parameters<typeof onePerSite>[0]) {
      return onePerSite(sites, parents).map(s => s.url);
    }
    expect(urls([
      { ...site, url: "http://localhost:57530", pid: 101, command: "workerd" },
      { ...site, url: "http://localhost:4321", pid: 100, command: "node" },
      { ...site, url: "http://localhost:4400", pid: 200, command: "node" },
      { ...site, id: "site_2", url: "http://localhost:1340", pid: 300 }
    ])).toEqual(["http://localhost:4321", "http://localhost:4400", "http://localhost:1340"]);
    // workerd on its own is a server like any other.
    expect(urls([{ ...site, url: "http://localhost:8787", pid: 101, command: "workerd" }])).toEqual(["http://localhost:8787"]);
    // One process on two ports is one server.
    expect(urls([{ ...site, url: "http://localhost:5174", pid: 100 }, { ...site, url: "http://localhost:5173", pid: 100 }])).toEqual(["http://localhost:5173"]);
    // Without the process tree, nothing is guessed: both stay.
    expect(onePerSite([{ ...site, url: "http://localhost:57530", pid: 101 }, { ...site, url: "http://localhost:4321", pid: 100 }], new Map()).length).toBe(2);
  });
});

describe("tui local panel", () => {
  test("runs as admin dev with the options given", () => {
    expect(panelArgs({ port: "5183", site: "http://localhost:4321", name: " ", accent: "#dd843c" })).toEqual(["admin", "dev", "--port", "5183", "--site", "http://localhost:4321", "--accent", "#dd843c"]);
  });
});
