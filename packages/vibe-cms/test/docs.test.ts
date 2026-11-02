import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadTopics, search } from "../src/cli/docs.ts";

const REPO = path.join(import.meta.dir, "../../..");
const topics = await loadTopics();
const names = new Set(topics.map(topic => topic.name));

/** Fenced code blocks, with the line each starts on. */
function codeBlocks(body: string): Array<{ code: string, line: number }> {
  const blocks: Array<{ code: string, line: number }> = [];
  const lines = body.split("\n");
  for(let i = 0; i < lines.length; i++) {
    if(!lines[i]!.startsWith("```")) continue;
    const start = i;
    while(++i < lines.length && !lines[i]!.startsWith("```"));
    blocks.push({ code: lines.slice(start + 1, i).join("\n"), line: start + 1 });
  }
  return blocks;
}

const SOURCE = /^\/\/ (examples\/\S+)$/m;

describe("docs", () => {
  test("every topic has a title and a one-paragraph summary", () => {
    expect(topics.length).toBeGreaterThan(0);
    for(const topic of topics) {
      expect(topic.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(topic.body.startsWith("# ")).toBe(true);
      expect(topic.summary.length, `${topic.name} needs a summary under its title`).toBeGreaterThan(20);
      expect(topic.summary.length, `${topic.name}'s summary is one short paragraph`).toBeLessThan(220);
      expect(topic.summary.startsWith("#") || topic.summary.startsWith("```")).toBe(false);
    }
  });

  // A block whose first line (after Astro's `---`) is `// examples/<file>` is quoted from that
  // file, so changing an example without its docs, or the other way round, fails here.
  test("code quoted from the examples matches them", () => {
    for(const topic of topics) {
      for(const block of codeBlocks(topic.body)) {
        const source = SOURCE.exec(block.code.split("\n").slice(0, 2).join("\n"));
        if(!source) continue;
        const file = path.join(REPO, source[1]!);
        const where = `${topic.name}.md:${block.line} quotes ${source[1]}`;
        expect(existsSync(file), `${where}, which doesn't exist`).toBe(true);
        const quoted = block.code.replace(`${source[0]}\n`, "");
        expect(readFileSync(file, "utf8").includes(quoted), `${where}, but the file has changed`).toBe(true);
      }
    }
  });

  test("links between topics resolve", () => {
    for(const topic of topics) {
      for(const [, name] of topic.body.matchAll(/`vibe-cms docs ([a-z][a-z0-9-]*)`/g)) {
        if(name === "topics" || name === "search") continue;
        expect(names.has(name!), `${topic.name} links to missing topic "${name}"`).toBe(true);
      }
      for(const [, file] of topic.body.matchAll(/\]\(\.\/([\w-]+)\.md(?:#[\w-]+)?\)/g)) {
        expect(names.has(file!), `${topic.name} links to missing ${file}.md`).toBe(true);
      }
    }
  });

  test("search finds lines across topics", () => {
    const [first] = topics;
    const word = first!.title.split(/\s+/)[0]!;
    expect(search(topics, [word]).some(hit => hit.startsWith(`${first!.name}: `))).toBe(true);
  });
});
