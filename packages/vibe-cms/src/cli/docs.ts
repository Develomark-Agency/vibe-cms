import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { command, restPositionals, string } from "cmd-ts";

/**
 * `vibe-cms docs`: the package's guides, printed as Markdown so agents and
 * people can read them where they work. Topics are the files in `docs/`.
 */

export const DOCS_DIR = fileURLToPath(new URL("../../docs/", import.meta.url));

export interface Topic {
  name: string,
  title: string,
  /** The paragraph under the title. */
  summary: string,
  body: string
}

export async function loadTopics(dir = DOCS_DIR): Promise<Topic[]> {
  const files = (await readdir(dir)).filter(file => file.endsWith(".md")).sort();
  return Promise.all(files.map(async file => parseTopic(file.slice(0, -3), await readFile(path.join(dir, file), "utf8"))));
}

/** A topic is `# Title`, a one-paragraph summary, then the guide. */
export function parseTopic(name: string, body: string): Topic {
  const [heading = "", ...rest] = body.split("\n");
  const summary = rest.join("\n").trim().split(/\n\s*\n/)[0] ?? "";
  return { name, title: heading.replace(/^#\s+/, "").trim(), summary: summary.replace(/\s+/g, " "), body };
}

function index(topics: Topic[]): string {
  const width = Math.max(...topics.map(topic => topic.name.length));
  return [
    "Topics (read one with `vibe-cms docs <topic>`, search with `vibe-cms docs search <words>`):",
    "",
    ...topics.map(topic => `  ${topic.name.padEnd(width)}  ${topic.summary}`)
  ].join("\n");
}

/** Lines mentioning every word, with the topic each is in. */
export function search(topics: Topic[], words: string[]): string[] {
  const terms = words.map(word => word.toLowerCase());
  const hits: string[] = [];
  for(const topic of topics) {
    for(const line of topic.body.split("\n")) {
      const lower = line.toLowerCase();
      if(terms.every(term => lower.includes(term))) hits.push(`${topic.name}: ${line.trim()}`);
    }
  }
  return hits;
}

export const docs = command({
  name: "docs",
  description: "Read the Vibe CMS guides: schemas, plugins, framework setup, agents",
  args: {
    words: restPositionals({ type: string, displayName: "topic", description: "A topic name, `topics`, or `search` followed by words" })
  },
  examples: [
    { description: "List the topics", command: "vibe-cms docs topics" },
    { description: "Read one", command: "vibe-cms docs plugins" },
    { description: "Find where something is covered", command: "vibe-cms docs search beforeWrite" }
  ],
  async handler({ words }) {
    const topics = await loadTopics();
    const [first, ...rest] = words;
    if(!first || first === "topics") {
      console.log(index(topics));
      return;
    }
    if(first === "search") {
      const hits = search(topics, rest);
      console.log(hits.length ? hits.join("\n") : `Nothing mentions "${rest.join(" ")}".`);
      return;
    }
    const topic = topics.find(t => t.name === first);
    if(!topic) {
      const near = topics.filter(t => t.name.includes(first) || first.includes(t.name)).map(t => t.name);
      console.error(`${styleText("red", "✗")} No topic "${first}".${near.length ? ` Did you mean ${near.join(", ")}?` : ""}\n`);
      console.error(index(topics));
      process.exitCode = 1;
      return;
    }
    console.log(topic.body);
  }
});
