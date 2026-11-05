import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createD1 } from "../../../packages/vibe-cms/test/helpers.ts";
import { freshIdToken, db } from "../src/server/shared.ts";
import * as t from "../src/server/schema.ts";
import { env, idp, installMock, jar, panel, removeMock, setupToken } from "./mock.ts";

/** Providers that don't say whether an email is verified (Clerk's metadata lists no such claim; Access's docs don't either). */

const shared = env.DB;
beforeAll(() => {
  installMock();
  env.DB = createD1() as unknown as D1Database;
});
afterAll(() => {
  env.DB = shared;
  idp.claims = {};
  idp.refresh = "id_token";
  delete env.OIDC_TRUST_EMAIL;
  removeMock();
});
beforeEach(() => {
  idp.claims = {};
  idp.refresh = "id_token";
  delete env.OIDC_TRUST_EMAIL;
  env.PANEL_ALLOW = "agency.test";
});

async function signInAs(email: string, sub: string, setup?: string) {
  idp.email = email;
  idp.sub = sub;
  jar.clear();
  const login = await panel(`/auth/login${setup ? `?setup=${setup}` : ""}`);
  const authorize = new URL(login.headers.get("location")!);
  idp.nonce = authorize.searchParams.get("nonce")!;
  return panel(`/auth/callback?code=good-code&state=${authorize.searchParams.get("state")}`);
}

function refusal(response: Response) {
  return decodeURIComponent(new URL(response.headers.get("location")!).searchParams.get("error") ?? "");
}

describe("a provider with no email_verified claim", () => {
  test("a domain rule can't be met without trusting its emails, and can with OIDC_TRUST_EMAIL", async () => {
    idp.claims = { email_verified: undefined };
    await panel("/api/setup");
    const setup = (await setupToken())!;

    expect(refusal(await signInAs("jane@agency.test", "u-jane", setup))).toContain("isn't allowed");

    env.OIDC_TRUST_EMAIL = "1";
    const done = await signInAs("jane@agency.test", "u-jane", setup);
    expect(refusal(done)).toBe("");
    expect(await (await panel("/api/me")).json()).toMatchObject({ role: "owner" });
  });

  test("an invite by email still becomes a membership when the emails are trusted", async () => {
    env.OIDC_TRUST_EMAIL = "1";
    idp.claims = { email_verified: undefined };
    await signInAs("jane@agency.test", "u-jane");
    expect((await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "bob@agency.test", role: "admin" }) })).status).toBeLessThan(300);
    await signInAs("bob@agency.test", "u-bob");
    expect(await (await panel("/api/me")).json()).toMatchObject({ role: "admin" });
  });

  test("without trust, the same invite stays waiting (the email isn't proven to be Bob's)", async () => {
    idp.claims = { email_verified: undefined };
    env.PANEL_ALLOW = "";
    await signInAs("carol@agency.test", "u-carol");
    expect((await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "dave@agency.test", role: "admin" }) })).status).toBe(403);
    await signInAs("jane@agency.test", "u-jane");
    expect((await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "dave@agency.test", role: "admin" }) })).status).toBeLessThan(300);
    await signInAs("dave@agency.test", "u-dave");
    expect(await (await panel("/api/me")).json()).toMatchObject({ role: null });
  });

  test("a group rule works whatever the provider says about emails (Cloudflare Access's groups scope)", async () => {
    env.PANEL_ALLOW = "staff";
    idp.claims = { email_verified: undefined, groups: ["staff"] };
    expect(refusal(await signInAs("jane@agency.test", "u-jane"))).toBe("");
    idp.claims = { email_verified: undefined, groups: ["contractors"] };
    expect(refusal(await signInAs("eve@evil.test", "u-eve"))).toContain("isn't allowed");
  });
});

describe("sessions with providers that give no refresh ID token", () => {
  /** A signed-in session whose ID token has already expired. */
  async function expiredSession() {
    await signInAs("jane@agency.test", "u-jane");
    const [row] = await db(env).select().from(t.sessions).where(eq(t.sessions.sub, "https://idp.test|u-jane")).limit(1);
    const expired = `${btoa("{\"alg\":\"none\"}")}.${btoa(JSON.stringify({ exp: 1 }))}.x`;
    await db(env).update(t.sessions).set({ id_token: expired, refresh_token: "r1" }).where(eq(t.sessions.id, row!.id));
    return { ...row!, id_token: expired, refresh_token: "r1" };
  }

  test("a refresh that returns only a new refresh token keeps the session going", async () => {
    const session = await expiredSession();
    idp.refresh = "none";
    expect(await freshIdToken(env, session)).toBe(session.id_token);
    const [after] = await db(env).select().from(t.sessions).where(eq(t.sessions.id, session.id));
    expect(after!.refresh_token).toBe("r2");
  });

  test("a refresh that returns an ID token replaces it", async () => {
    const session = await expiredSession();
    const renewed = await freshIdToken(env, session);
    expect(renewed).not.toBe(session.id_token);
  });
});
