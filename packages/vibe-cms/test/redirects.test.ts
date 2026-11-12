import { describe, expect, test } from "bun:test";
import { checkRule, covers, documentUrl, findLoop, normalizePath, RedirectError, RedirectIndex, resolveRedirect, type MatchRule } from "../src/redirects.ts";

function rule(from: string, to: string, extra: Partial<MatchRule> = {}): MatchRule {
  return { id: `r_${from}`, from, to, status: 301, keepQuery: true, ...extra };
}

function go(rules: MatchRule[], url: string) {
  return resolveRedirect(new RedirectIndex(rules), new URL(url, "https://site.test"));
}

describe("normalizePath", () => {
  test("trailing slash, escape case and doubled slashes", () => {
    expect(normalizePath("/about/")).toBe("/about");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/caf%c3%a9")).toBe("/caf%C3%A9");
    expect(normalizePath("/a//b")).toBe("/a/b");
    expect(normalizePath("/About")).toBe("/About");
  });
});

describe("matching", () => {
  test("exact paths, ignoring a trailing slash", () => {
    const rules = [rule("/old", "/new")];
    expect(go(rules, "/old")?.location).toBe("/new");
    expect(go(rules, "/old/")?.location).toBe("/new/");
    expect(go(rules, "/older")).toBeNull();
  });

  test("a trailing wildcard fills the target, and the exact rule wins", () => {
    const rules = [rule("/blog/*", "/news/*"), rule("/blog/special", "/elsewhere")];
    expect(go(rules, "/blog/a/b")?.location).toBe("/news/a/b");
    expect(go(rules, "/blog/special")?.location).toBe("/elsewhere");
    expect(go(rules, "/blog")).toBeNull();
  });

  test("the longest wildcard prefix wins", () => {
    const rules = [rule("/docs/*", "/help/*"), rule("/docs/v1/*", "/archive/v1/*")];
    expect(go(rules, "/docs/v1/intro")?.location).toBe("/archive/v1/intro");
    expect(go(rules, "/docs/v2/intro")?.location).toBe("/help/v2/intro");
  });

  test("the query is kept or dropped, and joins a target's own", () => {
    expect(go([rule("/a", "/b")], "/a?x=1")?.location).toBe("/b?x=1");
    expect(go([rule("/a", "/b", { keepQuery: false })], "/a?x=1")?.location).toBe("/b");
    expect(go([rule("/a", "/b?y=2")], "/a?x=1")?.location).toBe("/b?y=2&x=1");
  });

  test("absolute targets and the status", () => {
    const hit = go([rule("/a/*", "https://example.com/z/*", { status: 308 })], "/a/q");
    expect(hit).toMatchObject({ location: "https://example.com/z/q", status: 308 });
  });
});

describe("checkRule", () => {
  function check(from: string, to: string) {
    return checkRule({ from, to }, "/_vibe");
  }

  test("normalizes and defaults", () => {
    expect(check("/Old/", "/new")).toEqual({ from: "/Old", to: "/new", status: 301, keepQuery: true });
    expect(check("/blog/*", "/news/*").from).toBe("/blog/*");
  });

  test("refuses what can't work", () => {
    function refused(from: string, to: string, message: RegExp) {
      expect(() => check(from, to)).toThrow(message);
    }
    refused("old", "/new", /starting with \//);
    refused("/a?b=1", "/new", /path only/);
    refused("/a/*/b", "/new", /only at the end/);
    refused("/blog*", "/new", /after a slash/);
    refused("/*", "/new", /whole site/);
    refused("/_vibe", "/new", /own/);
    refused("/_vibe/admin", "/new", /own/);
    refused("/_vib*", "/new", /after a slash/);
    refused("/a", "/a", /same/);
    refused("/a", "/b/*", /no wildcard/);
    refused("/a", "javascript:alert(1)", /path starting|full URL/);
    refused("/a", "", /empty/);
    expect(() => checkRule({ from: "/a", to: "/b", status: 303 }, "/_vibe")).toThrow(RedirectError);
  });
});

describe("loops", () => {
  test("a direct loop and a longer one", () => {
    expect(findLoop([rule("/a", "/b")], rule("/b", "/a"))).not.toBeNull();
    expect(findLoop([rule("/a", "/b"), rule("/b", "/c")], rule("/c", "/a"))).not.toBeNull();
  });

  test("a chain that ends is fine", () => {
    expect(findLoop([rule("/a", "/b")], rule("/b", "/c"))).toBeNull();
    expect(findLoop([], rule("/x", "https://example.com/x"))).toBeNull();
  });

  test("loops through wildcards", () => {
    expect(findLoop([], rule("/a/*", "/a/b/*"))).not.toBeNull();
    expect(findLoop([rule("/a/*", "/b/*")], rule("/b/*", "/a/*"))).not.toBeNull();
    expect(findLoop([rule("/a/*", "/b/*")], rule("/c/*", "/d/*"))).toBeNull();
  });
});

test("covers: whether a rule would hide a page", () => {
  expect(covers("/a", "/a/")).toBe(true);
  expect(covers("/blog/*", "/blog/post")).toBe(true);
  expect(covers("/blog/*", "/blog")).toBe(false);
  expect(covers("/a", "/b")).toBe(false);
});

describe("documentUrl", () => {
  test("url function, templates and the page path convention", () => {
    expect(documentUrl({ url: doc => `/p/${doc.slug}` }, false, { slug: "x" }, "id", "en")).toBe("/p/x");
    expect(documentUrl({ preview: "/posts/{slug}" }, false, { slug: "hello world" }, "id", "en")).toBe("/posts/hello%20world");
    expect(documentUrl({ url: "/{locale}/posts/{slug}" }, false, { slug: "x" }, "id", "fr")).toBe("/fr/posts/x");
    expect(documentUrl(undefined, true, { path: "/about/" }, "id", "en")).toBe("/about");
    expect(documentUrl(undefined, false, { path: "/about" }, "id", "en")).toBeNull();
    expect(documentUrl({ preview: "https://x.test/{slug}" }, false, { slug: "x" }, "id", "en")).toBeNull();
    expect(documentUrl({ preview: "/posts/{slug}" }, false, {}, "id", "en")).toBeNull();
  });
});
