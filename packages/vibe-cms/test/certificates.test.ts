import { afterEach, describe, expect, test } from "bun:test";
import { BackupError, certificateProblem, takeSnapshot } from "../src/backups/index.ts";
import { trustSystemCertificates } from "../src/cli/trust.ts";

/** What Node's fetch throws when the site's certificate isn't trusted: a bare "fetch failed" with the reason as its cause. */
function untrusted(code = "SELF_SIGNED_CERT_IN_CHAIN") {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("self-signed certificate in certificate chain"), { code }) });
}

describe("certificateProblem", () => {
  test("names the certificate problem, from the error or its cause", () => {
    expect(certificateProblem(untrusted())).toContain("isn't trusted (self-signed certificate in certificate chain)");
    // Bun puts the code on the error itself.
    expect(certificateProblem(Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }))).toContain("NODE_EXTRA_CA_CERTS");
  });

  test("other failures aren't certificate problems", () => {
    expect(certificateProblem(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }))).toBeNull();
    expect(certificateProblem(new Error("boom"))).toBeNull();
    expect(certificateProblem(undefined)).toBeNull();
  });
});

describe("backups", () => {
  test("a certificate error fails at once instead of being retried", async () => {
    let calls = 0;
    const retries: string[] = [];
    const call = (async () => {
      calls++;
      throw untrusted();
    }) as never;
    const run = takeSnapshot({ call, store: {} as never, attempts: 5, onProgress: p => void (p.step === "retry" && retries.push(p.what)) });
    await expect(run).rejects.toBeInstanceOf(BackupError);
    await expect(run).rejects.toThrow("backups.manifest: The site's certificate isn't trusted");
    expect(calls).toBe(1);
    expect(retries).toEqual([]);
  });
});

describe("trustSystemCertificates", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("under Bun, every request also trusts the system's certificate authorities", async () => {
    const seen: Array<{ tls?: { ca?: string[] } }> = [];
    globalThis.fetch = (async (_input: unknown, init: { tls?: { ca?: string[] } }) => {
      seen.push(init);
      return new Response("ok");
    }) as unknown as typeof fetch;
    trustSystemCertificates(() => ["-----BEGIN CERTIFICATE-----\nlocal dev CA\n-----END CERTIFICATE-----"]);
    await fetch("https://my-site.localhost/");
    const ca = seen[0]!.tls!.ca!;
    expect(ca).toContain("-----BEGIN CERTIFICATE-----\nlocal dev CA\n-----END CERTIFICATE-----");
    // The bundled authorities stay, so public sites keep working.
    expect(ca.length).toBeGreaterThan(100);
  });

  test("leaves fetch alone when the system adds nothing", () => {
    trustSystemCertificates(() => []);
    expect(globalThis.fetch).toBe(realFetch);
  });
});
