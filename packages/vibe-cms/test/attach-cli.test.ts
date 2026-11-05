import { describe, expect, test } from "bun:test";
import { attach, describeAttached } from "../src/cli/attach.ts";

type Post = NonNullable<Parameters<typeof attach>[1]>;

function reply(status: number, body: unknown): Post {
  return async () => Response.json(body, { status });
}

describe("vibe-cms admin attach", () => {
  test("sends the link to the panel, and maps --template none to no starting roles", async () => {
    const calls: Array<{ path: string, body: unknown, options: unknown }> = [];
    async function post(path: string, body: unknown, options?: unknown) {
      calls.push({ path, body, options });
      return Response.json({ id: "site_1", name: "Client", url: "https://client.com" }, { status: 201 });
    }
    expect(await attach({ link: "https://client.com#claim=abc" }, post as Post)).toMatchObject({ name: "Client" });
    await attach({ link: "https://client.com#claim=abc", template: "none", hub: "agency.test" }, post as Post);
    await attach({ link: "https://client.com#claim=abc", template: "tpl_1" }, post as Post);
    expect(calls.map(c => c.path)).toEqual(["/site-attach", "/site-attach", "/site-attach"]);
    expect(calls[0]!.body).toEqual({ link: "https://client.com#claim=abc" });
    expect(calls[1]!.body).toEqual({ link: "https://client.com#claim=abc", templateId: null });
    expect(calls[1]!.options).toMatchObject({ hub: "agency.test" });
    expect(calls[2]!.body).toMatchObject({ templateId: "tpl_1" });
  });

  test("fails with the panel's own words", async () => {
    await expect(attach({ link: "https://x.test#claim=abc" }, reply(422, { error: "No _vibe-hub record for agency.test" }))).rejects.toThrow("No _vibe-hub record");
    await expect(attach({ link: "https://x.test#claim=abc" }, reply(502, {}))).rejects.toThrow("502");
  });

  test("says what happened to the starting roles", () => {
    const site = { id: "s", name: "Client", url: "https://client.com" };
    expect(describeAttached(site).join("\n")).toContain("Attached");
    expect(describeAttached({ ...site, template: { state: "pending" } }).join("\n")).toContain("once the site can be reached");
    expect(describeAttached({ ...site, template: { state: "failed", error: "boom" } }).join("\n")).toContain("boom");
    expect(describeAttached({ ...site, template: { state: "applied", skipped: ["a"] } }).join("\n")).toContain("1 role rule skipped");
  });
});
