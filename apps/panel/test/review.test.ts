import { afterAll, beforeAll, expect, test } from "bun:test";
import { env, HUB, idp, installMock, ISSUER, jar, panel, removeMock, signIn, siteId, sites } from "./mock.ts";

beforeAll(installMock);
afterAll(removeMock);

test("review lists unpublished changes on every visible site, asked as the person", async () => {
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
  await signIn();
  const a = await siteId("https://site-a.test");
  await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://site-a.test" }) });

  // Jane saves a post on the site without publishing it, as she would in the framed editor.
  const { userToken } = await import("../src/server/hub.ts");
  const { currentSession } = await import("../src/server/shared.ts");
  const session = await currentSession(new Request(HUB, { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } }), env);
  const token = await userToken(env, session!, a);
  const created = await sites["https://site-a.test"]!(new Request("https://site-a.test/_vibe/api/actions/documents.create", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "post", data: { title: "Draft post" } })
  }));
  const { id } = await created.json() as { id: string };

  const response = await panel("/api/review");
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  const entry = body.sites.find((s: any) => s.site.id === a);
  // Other tests share the mock site, so look for this one document.
  expect(entry.documents.find((d: any) => d.id === id)).toMatchObject({ type: "post", title: "Draft post", live: false, canPublish: true, pending: [{ owner: `${ISSUER}|u-jane`, name: "Jane" }] });
});
