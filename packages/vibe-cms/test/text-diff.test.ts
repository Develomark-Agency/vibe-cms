import { expect, test } from "bun:test";
import { plainText, textDiff, trimDiff } from "../src/changes/text.ts";

test("textDiff finds the words that changed", () => {
  expect(textDiff("How we moved the blog over", "How we moved our whole blog over")).toEqual([
    { op: "same", text: "How we moved " },
    { op: "remove", text: "the " },
    { op: "add", text: "our whole " },
    { op: "same", text: "blog over" }
  ]);
});

test("trimDiff keeps the changes and a little around them", () => {
  const before = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
  const after = before.replace("w100", "changed");
  const { parts, trimmed } = trimDiff(textDiff(before, after), 3);
  expect(trimmed).toBe(true);
  const shown = parts.map(p => p.text).join("");
  expect(shown).toContain("w97");
  expect(shown).not.toContain("w50 ");
  expect(parts.filter(p => p.op !== "same").map(p => p.text)).toEqual(["w100", "changed"]);
});

test("plainText reads rich text, one block a line", () => {
  const rich = [{ kind: "p", children: [{ text: "Hello " }, { text: "world", bold: true }] }, { kind: "h", level: 2, children: [{ text: "Next" }] }];
  expect(plainText(rich)).toBe("Hello world\nNext");
  expect(plainText({ asset: "a1" })).toBeNull();
});
