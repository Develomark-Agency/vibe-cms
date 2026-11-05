import { Hono } from "hono";
import { HttpError } from "../../config.ts";
import { consumeCode, createCode, issueSession } from "../auth.ts";
import { PREVIEW_TTL, previewCookie, previewScriptResponse, previewWindowResponse, safePath } from "../preview.ts";
import { redirect, type SiteEnv } from "../http.ts";

/**
 * The editor's draft preview of the site's own pages, from the site's side. Public routes: the preview
 * script, and the preview window the editor opens (trading its one-time code for a cookie).
 */
export function previewPages(prefix: string) {
  const app = new Hono<SiteEnv>();

  app.get("/preview.js", () => previewScriptResponse(prefix));

  // `GET {prefix}/preview?code=…&path=/…`: trades the editor's code for a preview cookie, then opens the
  // page, or with `window=1` the pop-out's window page around it.
  app.get("/preview", async c => {
    const { state } = c.env;
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    if(!code) throw new HttpError(400, "Expected a code");
    // Previews only read drafts, so they keep their hour even when the hub vouched for the editor.
    const { hubOrg: _hub, ...session } = await consumeCode(state.db, code);
    const { token, expiresAt } = await issueSession(state.db, session, state.siteId, url.origin);
    const cookie = previewCookie(token, Math.min(PREVIEW_TTL, expiresAt - Math.floor(Date.now() / 1000)), url.protocol === "https:");
    const path = safePath(url.searchParams.get("path"));
    return redirect(url, url.searchParams.get("window") === "1" ? `${state.prefix}/preview/window?path=${encodeURIComponent(path)}` : path, cookie);
  });

  app.get("/preview/window", c => previewWindowResponse(prefix, safePath(c.req.query("path") ?? null)));

  app.get("/preview/exit", c => {
    const url = new URL(c.req.url);
    return redirect(url, safePath(url.searchParams.get("path")), previewCookie("", 0, url.protocol === "https:"));
  });

  return app;
}

/** What the signed-in editor calls to start and stop a preview, under `/api`. */
export const previewApi = new Hono<SiteEnv>()
  // A one-time code the preview window trades for its cookie at `GET {prefix}/preview`.
  .post("/preview", async c => {
    const session = c.get("session");
    if(!session) throw new HttpError(401, "Sign in required");
    return c.json({ code: await createCode(c.env.state.db, session), expiresIn: 30 });
  })

  // The editor closed its preview: the cookie goes with it (from the editor's own cookie jar, or partition).
  .delete("/preview", c => c.json({ ok: true }, 200, { "set-cookie": previewCookie("", 0, new URL(c.req.url).protocol === "https:") }));
