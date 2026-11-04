import { afterAll, beforeAll, expect, test } from "bun:test";
import { hc } from "hono/client";
import { PanelError } from "vibe-cms/panel";
import type { PanelApi } from "../src/server/index.ts";
import { hostedBackend } from "../src/web/backend.ts";
import { HUB, idp, installMock, panel, removeMock, signIn } from "./mock.ts";

/** The web client's `fetch`, answered by the panel with the test's signed-in cookies. */
function fetchPanel(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  return panel(url.pathname + url.search, init);
}

beforeAll(async () => {
  installMock();
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
  await signIn();
});
afterAll(removeMock);

test("the hosted backend reaches the panel's routes through a typed client", async () => {
  const backend = hostedBackend(HUB, fetchPanel as typeof fetch);
  expect(await backend.me()).toMatchObject({ email: "jane@agency.test" });
  expect(await backend.branding()).toMatchObject({ name: expect.any(String) });
  const site = await backend.addSite("https://site-a.test");
  expect(site).toMatchObject({ url: "https://site-a.test", favorite: false });
  await backend.setFavorite(site.id, true);
  expect((await backend.sites()).find(s => s.id === site.id)?.favorite).toBe(true);
  await backend.setFavorite(site.id, false);
  expect(await backend.codeFor(site.id)).toEqual(expect.any(String));
  expect(await backend.backups!.status()).toMatchObject({ available: false });
  await backend.removeSite(site.id);
  expect((await backend.sites()).some(s => s.id === site.id)).toBe(false);
});

test("a failed call throws the panel's message", async () => {
  const backend = hostedBackend(HUB, fetchPanel as typeof fetch);
  const error = await backend.addSite("https://nowhere.invalid").catch((e: PanelError) => e) as PanelError;
  expect(error).toBeInstanceOf(PanelError);
  expect(error.message).toBeTruthy();
  await signIn("bad-code");
  expect(await hostedBackend(HUB, (async () => new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 })) as unknown as typeof fetch).me()).toBeNull();
  await signIn();
});

test("route inputs are checked by the compiler", () => {
  const client = hc<PanelApi>(HUB);
  // @ts-expect-error `url` is a string
  void (() => client.api.sites.$post({ json: { url: 1 } }));
  // @ts-expect-error there's no such route
  void (() => client.api.nope.$get());
  expect(true).toBe(true);
});
