import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { PanelError } from "vibe-cms/panel";
import { migrate, type Env } from "./shared.ts";
import { moveSites } from "./hub.ts";
import { processBackups } from "./backups.ts";
import { agents } from "./routes/agents.ts";
import { api } from "./routes/api.ts";
import { auth } from "./routes/auth.ts";
import type { AppEnv } from "./context.ts";

export type { Env } from "./shared.ts";

const app = new Hono<AppEnv>();

app.onError((error, c) => {
  // A body the validators couldn't read.
  if(error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if(error instanceof PanelError) return c.json({ error: error.message }, error.status as 400);
  console.error(error);
  return c.json({ error: "Internal error" }, 500);
});

app.use(async (c, next) => {
  await migrate(c.env.DB);
  await next();
});

// The route types the web client's `hc<PanelApi>()` reads.
const routes = app
  .route("/", agents)
  .route("/auth", auth)
  .route("/api", api);

export type PanelApi = typeof routes;

// The panel itself is a single-page app: unknown paths get index.html.
app.all("*", async c => {
  const assets = c.env.ASSETS;
  if(!assets) return c.text("Not found", 404);
  let response = await assets.fetch(c.req.raw);
  if(response.status === 404) response = await assets.fetch(new Request(new URL("/", c.req.url), c.req.raw));
  // The panel frames sites; nothing gets to frame the panel.
  const headers = new Headers(response.headers);
  headers.set("x-frame-options", "DENY");
  headers.set("content-security-policy", "frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, headers });
});

export function handle(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  return Promise.resolve(app.fetch(request, env, ctx));
}

/** Cron: scheduled snapshots, retries, and runs a stopped Worker left behind. */
export async function scheduled(env: Env) {
  await migrate(env.DB);
  await Promise.all([
    moveSites(env).catch(error => console.error("vibe-panel: moving sites to the org failed", error)),
    processBackups(env)
  ]);
}

export default {
  fetch: handle,
  scheduled: (_event, env, ctx) => ctx.waitUntil(scheduled(env))
} satisfies ExportedHandler<Env>;
