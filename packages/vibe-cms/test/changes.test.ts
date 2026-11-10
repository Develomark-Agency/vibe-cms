import { describe, expect, test } from "bun:test";
import v from "../src/schema/index.ts";
import { blocks, defineBlock } from "../src/blocks/index.ts";
import { Text } from "../src/blocks/builtins.ts";
import { assignKeys, check, diff, merge, type Branch } from "../src/changes/index.ts";

const Hero = defineBlock({ type: "hero", label: "Hero", fields: { heading: v.text(), align: v.enum(["left", "center"]) } });
const Quote = defineBlock({ type: "quote", label: "Testimonial", fields: { quote: v.text() } });

const schema = v.object({
  title: v.text(),
  description: v.optional(v.text()),
  seo: v.object({ description: v.text() }),
  tags: v.array(v.text()),
  blocks: blocks([Hero, Quote, Text])
});

const hero = { type: "hero", _key: "h", heading: "Welcome", align: "left" };
const quote = { type: "quote", _key: "q", quote: "Great" };
const base = { title: "Spring sale", seo: { description: "Old" }, tags: ["a"], blocks: [hero, quote] };

function edit(change: (doc: typeof base & Record<string, unknown>) => void) {
  const doc = structuredClone(base) as typeof base & Record<string, unknown>;
  change(doc);
  return doc;
}

describe("diff", () => {
  test("reports field changes by path with labels and detail", () => {
    const after = edit(doc => {
      doc.title = "Summer sale";
      doc.seo.description = "New";
      doc.tags.push("b");
      doc.description = "Added";
    });
    const changes = diff(schema, base, after);
    expect(changes.map(c => [c.path, c.kind, c.before, c.after, c.detail])).toEqual([
      ["title", "set", "Spring sale", "Summer sale", "value"],
      ["description", "set", undefined, "Added", "value"],
      ["seo.description", "set", "Old", "New", "value"],
      ["tags", "set", ["a"], ["a", "b"], "value"]
    ]);
    expect(changes[2]!.label).toEqual(["Seo", "Description"]);
  });

  test("blocks diff by key: edits inside, moves, adds and removes", () => {
    const after = edit(doc => {
      doc.blocks = [{ ...quote }, { ...hero, heading: "Hi" }, { type: "quote", _key: "n", quote: "New" }];
    });
    const changes = diff(schema, base, after);
    expect(changes.map(c => [c.path, c.kind])).toEqual([
      ["blocks[q]", "move"],
      ["blocks[h].heading", "set"],
      ["blocks[n]", "add"]
    ]);
    expect(changes[1]!.label).toEqual(["Blocks", "Hero", "Heading"]);
    const removed = diff(schema, base, edit(doc => { doc.blocks = [hero]; }));
    expect(removed.map(c => [c.path, c.kind, c.label.at(-1)])).toEqual([["blocks[q]", "remove", "Testimonial"]]);
  });

  test("rich text only says it changed", () => {
    const before = { ...base, blocks: [{ type: "text", _key: "t", body: [] }] };
    const after = { ...base, blocks: [{ type: "text", _key: "t", body: [{ type: "p", children: [{ text: "Hi" }] }] }] };
    const [change] = diff(schema, before, after);
    expect(change!.path).toBe("blocks[t].body");
    expect(change!.detail).toBe("changed-only");
  });

  test("lists without keys are one change", () => {
    const before = { ...base, blocks: [{ type: "hero", heading: "A", align: "left" }] };
    const after = { ...base, blocks: [{ type: "hero", heading: "B", align: "left" }] };
    expect(diff(schema, before, after).map(c => c.path)).toEqual(["blocks"]);
  });
});

describe("check and merge", () => {
  const alice: Branch = { owner: "alice", base, data: edit(doc => { doc.title = "Summer sale"; }) };
  const bob: Branch = { owner: "bob", base, data: edit(doc => { doc.title = "Winter sale"; doc.seo.description = "Bob's"; }) };

  test("separate fields merge cleanly into one version", () => {
    const carol: Branch = { owner: "carol", base, data: edit(doc => { doc.seo.description = "Carol's"; doc.blocks = [quote, hero]; }) };
    const result = merge(schema, base, { branches: [alice, carol] });
    expect(result.unresolved).toEqual([]);
    expect(result.data).toEqual(edit(doc => { doc.title = "Summer sale"; doc.seo.description = "Carol's"; doc.blocks = [quote, hero]; }));
    expect(result.rebased.get("alice")).toBeNull();
  });

  test("two people changing one field conflict until settled", () => {
    const checked = check(schema, base, [alice, bob]);
    expect(checked.get("alice")![0]).toMatchObject({ path: "title", status: "conflict", with: ["bob"], group: "title" });
    expect(checked.get("bob")!.map(c => c.status)).toEqual(["conflict", "clean"]);

    const open = merge(schema, base, { branches: [alice, bob] });
    expect(open.unresolved.map(u => [u.group, u.changes.map(c => c.owner)])).toEqual([["title", ["alice", "bob"]]]);

    const settled = merge(schema, base, { branches: [alice, bob], resolve: new Map([["title", { use: "bob" }]]) });
    expect(settled.unresolved).toEqual([]);
    expect(settled.data).toMatchObject({ title: "Winter sale", seo: { description: "Bob's" } });

    const typed = merge(schema, base, { branches: [alice, bob], resolve: new Map([["title", { value: "Autumn sale" }]]) });
    expect((typed.data as typeof base).title).toBe("Autumn sale");
  });

  test("the same change twice isn't a conflict", () => {
    const twin: Branch = { owner: "twin", base, data: alice.data };
    expect(merge(schema, base, { branches: [alice, twin] }).unresolved).toEqual([]);
  });

  test("skipped changes stay pending and don't conflict", () => {
    const result = merge(schema, base, { branches: [alice, bob], skip: new Map([["bob", new Set(["title"])]]) });
    expect(result.unresolved).toEqual([]);
    expect(result.data).toMatchObject({ title: "Summer sale", seo: { description: "Bob's" } });
    expect(result.rebased.get("bob")).toMatchObject({ title: "Winter sale", seo: { description: "Bob's" } });
    expect(result.published.get("bob")).toEqual(["seo.description"]);
  });

  test("a change live has moved on from is stale; one live already has is dropped", () => {
    const live = edit(doc => { doc.title = "Summer sale"; });
    const checked = check(schema, live, [bob, alice]);
    expect(checked.get("bob")![0]).toMatchObject({ status: "stale", live: "Summer sale", group: "title" });
    expect(checked.get("alice")![0]!.status).toBe("live");
    const result = merge(schema, live, { branches: [bob], resolve: new Map([["title", { use: "live" }]]) });
    expect(result.data).toMatchObject({ title: "Summer sale", seo: { description: "Bob's" } });
  });

  test("moving a block doesn't conflict with editing inside it; removing it does", () => {
    const mover: Branch = { owner: "mover", base, data: edit(doc => { doc.blocks = [quote, hero]; }) };
    const editor: Branch = { owner: "editor", base, data: edit(doc => { doc.blocks = [{ ...hero, heading: "Hi" }, quote]; }) };
    const remover: Branch = { owner: "remover", base, data: edit(doc => { doc.blocks = [quote]; }) };
    const moved = merge(schema, base, { branches: [mover, editor] });
    expect(moved.unresolved).toEqual([]);
    expect((moved.data as typeof base).blocks).toEqual([quote, { ...hero, heading: "Hi" }]);
    const removed = merge(schema, base, { branches: [editor, remover] });
    expect(removed.unresolved.map(u => u.group)).toEqual(["blocks[h]"]);
    const kept = merge(schema, base, { branches: [editor, remover], resolve: new Map([["blocks[h]", { use: "editor" }]]) });
    expect((kept.data as typeof base).blocks).toEqual([{ ...hero, heading: "Hi" }, quote]);
  });

  test("added blocks land after the block before them", () => {
    const adder: Branch = { owner: "adder", base, data: edit(doc => { doc.blocks = [hero, { type: "quote", _key: "n", quote: "New" }, quote]; }) };
    const live = edit(doc => { doc.blocks = [{ type: "quote", _key: "z", quote: "Live" }, hero, quote]; });
    expect((merge(schema, live, { branches: [adder] }).data as typeof base).blocks.map(b => b._key)).toEqual(["z", "h", "n", "q"]);
  });

  test("a never-published document merges onto nothing", () => {
    const creator: Branch = { owner: "alice", base: null, data: base };
    expect(merge(schema, null, { branches: [creator] }).data).toEqual(base);
  });
});

test("assignKeys fills missing and duplicated keys", () => {
  const doc = { ...base, blocks: [{ type: "hero", heading: "A", align: "left" }, hero, { ...hero }] };
  let n = 0;
  expect(assignKeys(schema, doc, () => `k${++n}`)).toBe(true);
  expect(doc.blocks.map(b => (b as { _key?: string })._key)).toEqual(["k1", "h", "k2"]);
  expect(assignKeys(schema, doc, () => "x")).toBe(false);
});
