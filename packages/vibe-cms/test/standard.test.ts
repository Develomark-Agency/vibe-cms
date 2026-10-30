import { describe, expect, test } from "bun:test";
import { serializeConfig } from "../src/config.ts";
import v from "../src/schema/index.ts";
import { config } from "./fixture.ts";

const { post } = config.schemas;

describe("Standard Schema", () => {
  test("validates through ~standard", () => {
    const standard = post["~standard"];
    expect(standard.version).toBe(1);
    expect(standard.vendor).toBe("vibe-cms");
    const ok = standard.validate({ title: "Hi", slug: "hi", tags: [], layout: "default", extra: 1 });
    expect(ok).toEqual({ value: { title: "Hi", slug: "hi", tags: [], layout: "default" } });
    const bad = standard.validate({ title: "", slug: "Not A Slug", tags: [], layout: "huge" });
    expect(bad.issues?.map(i => i.path)).toEqual([["title"], ["slug"], ["layout"]]);
  });

  test("field schemas carry it too", () => {
    expect(v.text({ min: 2 })["~standard"].validate("a").issues).toHaveLength(1);
    expect(v.array(v.number())["~standard"].validate([1, 2])).toEqual({ value: [1, 2] });
  });

  test("converts content types to JSON Schema", () => {
    const schema = post["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe("post");
    expect(schema.required).toEqual(["title", "slug", "tags", "layout"]);
    const props = schema.properties as Record<string, any>;
    expect(props.title).toEqual({ type: "string", minLength: 1, maxLength: 120 });
    expect(props.slug.pattern).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$");
    expect(props.layout).toEqual({ type: "string", enum: ["default", "wide"] });
    expect(props.publishedAt).toEqual({ type: "string", format: "date" });
    expect(props.author).toEqual({ type: "string", description: "ID of a document of type \"author\"" });
    expect(props.cover.required).toEqual(["asset", "alt"]);
    expect(props.cover.properties.asset.description).toContain("image/*");
    expect(props.seo.additionalProperties).toBe(false);
    expect(post["~standard"].jsonSchema.input({ target: "draft-07" }).$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(() => post["~standard"].jsonSchema.input({ target: "draft-04" })).toThrow();
  });

  test("stays out of the serialized config", () => {
    const json = JSON.stringify(serializeConfig(config));
    expect(json).not.toContain("~standard");
    expect(Object.keys(v.text())).not.toContain("~standard");
  });
});
