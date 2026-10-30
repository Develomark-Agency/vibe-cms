import { describe, expect, test } from "bun:test";
import { siteOrigin } from "../src/panel/backend.ts";

describe("site addresses", () => {
  test("default to HTTPS", () => {
    expect(siteOrigin("example.com")).toBe("https://example.com");
    expect(siteOrigin("example.com/blog")).toBe("https://example.com");
  });

  test("default to HTTP for local dev servers", () => {
    expect(siteOrigin("localhost:4321")).toBe("http://localhost:4321");
    expect(siteOrigin("goose.localhost:4321")).toBe("http://goose.localhost:4321");
    expect(siteOrigin("127.0.0.1:4321")).toBe("http://127.0.0.1:4321");
    expect(siteOrigin("[::1]:4321")).toBe("http://[::1]:4321");
  });

  test("keep an explicit scheme", () => {
    expect(siteOrigin("https://localhost:4321")).toBe("https://localhost:4321");
    expect(siteOrigin("http://example.com")).toBe("http://example.com");
  });

  test("reject garbage", () => {
    expect(() => siteOrigin("not a url")).toThrow();
  });
});
