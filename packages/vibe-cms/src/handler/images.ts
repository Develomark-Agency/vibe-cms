/**
 * Image optimization: resized, re-encoded copies of uploaded images made by Cloudflare's Images
 * binding when a media URL asks for a width (`/_vibe/media/<id>.jpg?w=800`). Originals in R2 are
 * never changed. When transforming fails, the original is served instead and the site records
 * why, which the editor and the agency panel show as a warning.
 */
import { IMAGE_WIDTHS } from "../media/widths.ts";
import type { AssetMeta } from "../schema/types.ts";
import { getMeta, run } from "./db.ts";
import type { D1, ExecutionContext, ImagesBinding, R2 } from "./platform.ts";

/** Formats the binding reads and writes. GIFs (often animated) and SVGs are served as they are. */
const TRANSFORMABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

const DEFAULT_QUALITY = 80;

/** Served instead of a transformed image while optimization is failing, so a fix shows up soon. */
const FALLBACK_CACHE = "public, max-age=300";

export type ImageProblem = "not-enabled" | "quota" | "error";

export interface ImageStatus {
  state: "ok" | "degraded",
  /** Why it's degraded. */
  problem?: ImageProblem,
  /** The binding's own error message. */
  detail?: string,
  /** When the current state began. */
  since: number,
  /** When it was last confirmed, by a transform or the probe. */
  checkedAt: number
}

/** Something about the site that needs a developer's attention; the editor and the panel show these. */
export interface SiteWarning {
  code: "images.missing-binding" | `images.${ImageProblem}`,
  message: string,
  /** `vibe-cms docs <topic>` for the fix. */
  docs?: string,
  since?: string
}

const STATUS_KEY = "images_status";
/** How long one isolate trusts the status it read or wrote before reading it again. */
const STATUS_TTL = 60_000;
/** How often the probe runs while things look fine. */
const PROBE_EVERY = 6 * 60 * 60_000;
/** At most one probe a minute, however many transforms fail. */
const PROBE_GAP = 60_000;

/** A 1×1 PNG, transformed by the probe: the same source and options each time, so it's billed once a month. */
const PROBE_PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
), c => c.charCodeAt(0));

/** Sorts a binding error into something a developer can act on. */
export function classifyImageError(error: unknown): ImageProblem {
  const message = error instanceof Error ? error.message : String(error);
  if(/quota|limit exceeded|too many|429|billing|payment/i.test(message)) return "quota";
  if(/not enabled|not allowed|unauthori[sz]ed|forbidden|permission|entitle|403|subscription/i.test(message)) return "not-enabled";
  return "error";
}

/**
 * The site's image optimization health, shared by the requests one isolate handles. Reads and
 * writes `vibe_meta` sparingly: a busy page doesn't write per image.
 */
export class ImageHealth {
  private cached: { status: ImageStatus | null, at: number } | null = null;
  private lastProbe = 0;
  private probing: Promise<ImageStatus> | null = null;

  constructor(private db: D1, private images: ImagesBinding | false | undefined) {}

  async status(): Promise<ImageStatus | null> {
    if(this.cached && Date.now() - this.cached.at < STATUS_TTL) return this.cached.status;
    const raw = await getMeta(this.db, STATUS_KEY).catch(() => null);
    const status = raw ? JSON.parse(raw) as ImageStatus : null;
    this.cached = { status, at: Date.now() };
    return status;
  }

  /** Records a result, writing only when the state changes or the last write is getting old. */
  async record(result: { ok: true } | { ok: false, problem: ImageProblem, detail: string }): Promise<ImageStatus> {
    const now = Date.now();
    const previous = await this.status();
    const state = result.ok ? "ok" : "degraded";
    const problem = result.ok ? undefined : result.problem;
    const same = previous?.state === state && previous.problem === problem;
    const next: ImageStatus = {
      state,
      ...(problem ? { problem, detail: (result as { detail: string }).detail.slice(0, 300) } : {}),
      since: same ? previous!.since : now,
      checkedAt: now
    };
    if(!same || now - previous!.checkedAt > PROBE_EVERY / 2) {
      await run(this.db, "INSERT OR REPLACE INTO vibe_meta (key, value) VALUES (?, ?)", [STATUS_KEY, JSON.stringify(next)]);
    }
    this.cached = { status: next, at: now };
    return next;
  }

  /**
   * Transforms a tiny known-good image. Tells a broken setup apart from one bad file, and catches
   * a broken setup on a site that hasn't served an image yet. Throttled; concurrent calls share one run.
   */
  probe(options: { force?: boolean } = {}): Promise<ImageStatus> | null {
    const images = this.images;
    if(!images) return null;
    if(this.probing) return this.probing;
    if(!options.force && Date.now() - this.lastProbe < PROBE_GAP) return null;
    this.lastProbe = Date.now();
    this.probing = (async () => {
      try {
        const result = await images.input(new Response(PROBE_PNG).body!).transform({ width: 1 }).output({ format: "image/webp" });
        await result.response().body?.cancel();
        return await this.record({ ok: true });
      } catch (error) {
        return await this.record({ ok: false, problem: classifyImageError(error), detail: errorText(error) });
      } finally {
        this.probing = null;
      }
    })();
    return this.probing;
  }

  /** Probes in the background when the last check is old: the editor loading and cron call this. */
  async refresh(ctx?: ExecutionContext): Promise<void> {
    if(!this.images) return;
    const status = await this.status();
    if(status && Date.now() - status.checkedAt < PROBE_EVERY) return;
    const probe = this.probe();
    if(!probe) return;
    if(ctx?.waitUntil) ctx.waitUntil(probe.catch(() => {}));
    else await probe.catch(() => {});
  }

  /** What the editor and the panel warn about. Sites that set `images: false` opted out and get none. */
  async warnings(hasStorage: boolean): Promise<SiteWarning[]> {
    if(this.images === false || !hasStorage) return [];
    if(this.images === undefined) {
      return [{
        code: "images.missing-binding",
        message: "Images are served at full size: the site has no Images binding. Add one to resize and convert them to WebP and AVIF.",
        docs: "media"
      }];
    }
    const status = await this.status();
    if(status?.state !== "degraded") return [];
    const since = new Date(status.since).toISOString();
    const message = {
      "not-enabled": "Image optimization isn't enabled for this Cloudflare account or zone, so images are served at full size.",
      quota: "Image optimization has hit its limit (Cloudflare's free tier is 5,000 transformations a month), so images are served at full size.",
      error: "Image optimization is failing, so images are served at full size."
    }[status.problem ?? "error"];
    return [{ code: `images.${status.problem ?? "error"}`, message, docs: "media", since }];
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The width a request is served at: the next allowed width up, never wider than the original. */
export function snapWidth(requested: number, original: number | undefined): number {
  const width: number = IMAGE_WIDTHS.find(w => w >= requested) ?? IMAGE_WIDTHS.at(-1)!;
  return original && original < width ? original : width;
}

/** The best format the browser accepts: AVIF, then WebP, else the original's own. */
export function pickFormat(accept: string | null, original: string): string {
  if(accept?.includes("image/avif")) return "image/avif";
  if(accept?.includes("image/webp")) return "image/webp";
  return original === "image/png" ? "image/png" : "image/jpeg";
}

export interface TransformRequest {
  request: Request,
  storage: R2,
  key: string,
  mime: string,
  meta: AssetMeta,
  images: ImagesBinding | false | undefined,
  health: ImageHealth,
  ctx?: ExecutionContext
}

/**
 * A media request with `?w=`: the resized image, from the cache when it's there. `null` when the
 * request doesn't ask for one, or the file isn't an image the binding converts: serve it as it is.
 */
export async function serveTransformed(t: TransformRequest): Promise<Response | null> {
  const url = new URL(t.request.url);
  const requested = Number(url.searchParams.get("w"));
  if(!url.searchParams.has("w") || !TRANSFORMABLE.has(t.mime)) return null;
  if(!t.images) return original(t, t.images === false ? null : FALLBACK_CACHE);
  if(!Number.isFinite(requested) || requested <= 0) return null;

  const width = snapWidth(requested, t.meta.width);
  const quality = clampQuality(Number(url.searchParams.get("q")) || DEFAULT_QUALITY);
  const format = pickFormat(t.request.headers.get("accept"), t.mime);
  const cacheKey = new Request(`${url.origin}${url.pathname}?v=${url.searchParams.get("v") ?? ""}&w=${width}&q=${quality}&f=${format}`);
  const cache = edgeCache();
  const hit = await cache?.match(cacheKey).catch(() => undefined);
  if(hit) return withVary(hit);

  const object = await t.storage.get(t.key);
  if(!object) return new Response("Not found", { status: 404 });
  try {
    const result = await t.images.input(object.body).transform({ width, fit: "scale-down" }).output({ format, quality });
    const body = result.response().body;
    const response = new Response(body, {
      headers: {
        "content-type": result.contentType(),
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        vary: "Accept"
      }
    });
    const status = await t.health.status();
    if(status?.state === "degraded") t.ctx?.waitUntil(t.health.record({ ok: true }).catch(() => {}));
    if(cache) {
      const [send, keep] = response.body!.tee();
      t.ctx?.waitUntil(cache.put(cacheKey, new Response(keep, response)).catch(() => {}));
      return new Response(send, response);
    }
    return response;
  } catch (error) {
    console.error(`vibe-cms: couldn't transform ${t.key}; serving the original`, error);
    // The probe tells a broken setup from a file the binding can't read.
    const probe = t.health.probe();
    if(probe && t.ctx?.waitUntil) t.ctx.waitUntil(probe.catch(() => {}));
    else if(probe) await probe.catch(() => {});
    return original(t, FALLBACK_CACHE);
  }
}

async function original(t: TransformRequest, cacheControl: string | null): Promise<Response> {
  const object = await t.storage.get(t.key);
  if(!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? t.mime,
      "cache-control": cacheControl ?? "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      vary: "Accept"
    }
  });
}

function clampQuality(q: number): number {
  return Math.min(100, Math.max(30, Math.round(q)));
}

function withVary(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("vary", "Accept");
  return copy;
}

/** Cloudflare's per-colo cache (`caches.default`); absent outside Workers. */
function edgeCache(): { match(r: Request): Promise<Response | undefined>, put(r: Request, res: Response): Promise<void> } | null {
  const caches = (globalThis as { caches?: { default?: unknown } }).caches;
  return (caches?.default as ReturnType<typeof edgeCache>) ?? null;
}
