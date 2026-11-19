import { afterEach, describe, expect, mock, test } from "bun:test";

// The project's hub login lives in the OS keychain: stand in for it, keeping the rest of the module real.
const hubCalls: string[] = [];
const real = await import("../src/cli/login.ts");
mock.module("../src/cli/login.ts", () => ({
  ...real,
  hubSiteToken: async (site: string) => {
    hubCalls.push(site);
    throw new Error(`${site} isn't in this panel. Add it in the panel first.`);
  },
  siteLoginToken: async () => undefined,
  loginIfInteractive: async () => undefined
}));
const { isDevAddress, siteToken } = await import("../src/cli/actions.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  hubCalls.length = 0;
});

/** Answers the dev sign-in with `status`, or fails the way Node does when it can't connect. */
function siteAnswers(answer: number | Error) {
  globalThis.fetch = (async () => {
    if(answer instanceof Error) throw answer;
    return Response.json(answer === 200 ? { token: "dev-token" } : { error: "Dev sessions are only available in development" }, { status: answer });
  }) as unknown as typeof fetch;
}

describe("isDevAddress", () => {
  test("loopback, *.localhost and *.test are development addresses", () => {
    for(const site of ["http://localhost:4321", "https://my-site.localhost", "http://127.0.0.1:8787", "http://[::1]:3000", "http://0.0.0.0:3000", "https://client.test"]) {
      expect(isDevAddress(site)).toBe(true);
    }
  });

  test("anything else isn't", () => {
    for(const site of ["https://client.com", "https://localhost.example.com", "https://my-site.workers.dev", "not a url"]) {
      expect(isDevAddress(site)).toBe(false);
    }
  });
});

describe("siteToken", () => {
  test("a development site's own session wins, without asking the hub", async () => {
    siteAnswers(200);
    expect(await siteToken({ site: "https://my-site.localhost", prefix: "/_vibe" })).toBe("dev-token");
    expect(hubCalls).toEqual([]);
  });

  test("a development address never goes to the project's hub login, even without a dev session", async () => {
    siteAnswers(403);
    expect(await siteToken({ site: "https://my-site.localhost", prefix: "/_vibe" })).toBeUndefined();
    expect(hubCalls).toEqual([]);
  });

  test("a site that can't be reached says why, instead of falling through to the hub's refusal", async () => {
    siteAnswers(Object.assign(new TypeError("fetch failed"), { cause: new Error("self-signed certificate in certificate chain") }));
    await expect(siteToken({ site: "https://my-site.localhost", prefix: "/_vibe" })).rejects.toThrow("Couldn't reach https://my-site.localhost: self-signed certificate in certificate chain");
    expect(hubCalls).toEqual([]);
  });

  test("other sites still get their session through the hub", async () => {
    siteAnswers(403);
    await expect(siteToken({ site: "https://client.com", prefix: "/_vibe" })).rejects.toThrow("isn't in this panel");
    expect(hubCalls).toEqual(["https://client.com"]);
  });

  test("--token is used as given", async () => {
    siteAnswers(Object.assign(new TypeError("fetch failed"), { cause: new Error("unreachable") }));
    expect(await siteToken({ site: "https://my-site.localhost", prefix: "/_vibe", token: "given" })).toBe("given");
  });
});
