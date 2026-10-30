import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import v, { validate } from "vibe-cms/schema";
import { defineBlock, normalizePath, pageSchema, type BlockProps } from "../src/index.ts";
import { html, raw, renderBlock, renderBlocks, url } from "../src/html.ts";
import { Blocks } from "../src/react.tsx";

const Testimonial = defineBlock({
  type: "testimonial",
  label: "Testimonial",
  icon: "quote",
  fields: { quote: v.text({ min: 1 }), name: v.text() }
});

type Page = BlockProps<typeof Testimonial> | { type: "hero", heading: string, align: "left" | "center", buttons: Array<{ label: string, href: string, style: "primary" | "secondary" }>, eyebrow?: string, text?: string };

describe("html", () => {
  test("escapes interpolations, keeps nested html, drops empty values", () => {
    const name = "<script>alert(1)</script>";
    const out = html`<p title="${name}">${name}${html`<b>${"&"}</b>`}${null}${false}${[html`<i>1</i>`, "<2>"]}${raw("<hr>")}</p>`;
    expect(String(out)).toBe("<p title=\"&#60;script&#62;alert(1)&#60;/script&#62;\">&#60;script&#62;alert(1)&#60;/script&#62;<b>&#38;</b><i>1</i>&#60;2&#62;<hr></p>");
  });

  test("url() refuses script URLs", () => {
    expect(url("javascript:alert(1)")).toBe("#");
    expect(url(" /contact ")).toBe("/contact");
    expect(url("https://example.com/a?b")).toBe("https://example.com/a?b");
  });

  test("built-ins render to static, escaped markup", () => {
    const hero = renderBlock({ type: "hero", heading: "Hi <there>", align: "center", buttons: [{ label: "Go", href: "javascript:x", style: "primary" }] });
    expect(hero).toContain("<h1>Hi &#60;there&#62;</h1>");
    expect(hero).toContain("href=\"#\"");
    expect(hero).toContain("vb-hero--center");
    const video = renderBlock({ type: "video", url: "https://youtu.be/dQw4w9WgXcQ" });
    expect(video).toContain("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    const faq = renderBlock({ type: "faq", items: [{ question: "Why?", answer: "Because." }] });
    expect(faq).toContain("<details><summary>Why?</summary><p>Because.</p></details>");
  });

  test("custom components render their type; unknown types leave a comment, not an error", () => {
    const blocks: Page[] = [
      { type: "testimonial", quote: "Great", name: "Ada" },
      { type: "hero", heading: "Hello", align: "left", buttons: [] }
    ];
    const out = renderBlocks(blocks, { components: { testimonial: b => html`<q>${b.quote}</q> — ${b.name}` } });
    expect(out).toContain("<q>Great</q> — Ada");
    expect(out).toContain("<h1>Hello</h1>");
    expect(renderBlock({ type: "mystery" } as { type: string }, { components: {} as never })).toBe("<!-- vibe-cms: no component for block \"mystery\" -->");
  });
});

describe("pages", () => {
  test("normalizePath", () => {
    expect(normalizePath("/About/Team/")).toBe("/about/team");
    expect(normalizePath("about//team?x=1#y")).toBe("/about/team");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/docs/index.html")).toBe("/docs");
    expect(normalizePath("/caf%C3%A9")).toBe("/café");
  });

  test("pageSchema validates paths and tells blocks apart by type", () => {
    const schema = pageSchema({ blocks: [Testimonial] });
    const ok = validate(schema, {
      title: "About",
      path: "/about/team",
      blocks: [
        { type: "testimonial", quote: "Great", name: "Ada" },
        { type: "divider", style: "line" }
      ]
    });
    expect(ok.issues).toEqual([]);
    const bad = validate(schema, { title: "About", path: "/About/", blocks: [{ type: "testimonial", quote: "", name: "Ada" }] });
    expect(bad.issues.map(i => i.path.join("."))).toEqual(["path", "blocks.0.quote"]);
  });

  test("defineBlock refuses bad types and a `type` field", () => {
    expect(() => defineBlock({ type: "Bad Type", label: "x", fields: {} })).toThrow();
    expect(() => defineBlock({ type: "ok", label: "x", fields: { type: v.text() } })).toThrow();
  });
});

describe("react", () => {
  function Quote({ quote, name }: BlockProps<typeof Testimonial>) {
    // Hooks work: these are ordinary React components.
    const [open] = useState(true);
    return createElement("blockquote", { "data-open": open }, `${quote} — ${name}`);
  }

  test("renders custom components and built-ins in order", () => {
    const blocks: Page[] = [
      { type: "hero", heading: "Hello", align: "left", buttons: [] },
      { type: "testimonial", quote: "Great", name: "Ada" }
    ];
    const out = renderToStaticMarkup(createElement(Blocks<Page>, { blocks, components: { testimonial: Quote } }));
    expect(out.indexOf("<h1>Hello</h1>")).toBeLessThan(out.indexOf("<blockquote data-open=\"true\">Great — Ada</blockquote>"));
    expect(out).toContain("data-vibe-block=\"hero\" style=\"display:contents\"");
  });

  test("types: custom blocks need a component, built-ins don't", () => {
    const blocks: Page[] = [];
    // @ts-expect-error testimonial has no component
    createElement(Blocks<Page>, { blocks, components: {} });
    createElement(Blocks<Page>, { blocks, components: { testimonial: Quote } });
    // @ts-expect-error a component for the wrong block
    createElement(Blocks<Page>, { blocks, components: { testimonial: (props: { other: number }) => props.other } });
  });
});
