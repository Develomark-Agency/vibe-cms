import { describe, expect, test } from "bun:test";
import { createHandler } from "../src/handler/index.ts";
import { classifyImageError, pickFormat, snapWidth } from "../src/handler/images.ts";
import type { ImagesBinding } from "../src/handler/platform.ts";
import { focus, img, imageUrl } from "../src/media/index.ts";
import { imgTag, sizesAttribute } from "../src/media/img.ts";
import { config, roles } from "./fixture.ts";
import { createD1, createR2, ctx, png } from "./helpers.ts";

/** A stand-in Images binding: records each transform, or fails with `error`. */
function fakeImages(options: { error?: string } = {}) {
  const calls: Array<{ width?: number, format: string }> = [];
  const binding: ImagesBinding & { calls: typeof calls, error?: string } = {
    calls,
    error: options.error,
    input(stream) {
      let width: number | undefined;
      const transformer = {
        transform(o: { width?: number }) {
          width = o.width;
          return transformer;
        },
        async output(o: { format: string }) {
          await new Response(stream).arrayBuffer();
          if(binding.error) throw new Error(binding.error);
          calls.push({ width, format: o.format });
          return { response: () => new Response(`resized:${width}`), contentType: () => o.format };
        }
      };
      return transformer;
    }
  };
  return binding;
}

function setup(images: ImagesBinding | false | undefined) {
  const env = { DB: createD1({ roles }), MEDIA: createR2() };
  const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA, images }) });
  let token = "";
  async function call(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if(token) headers.set("authorization", `Bearer ${token}`);
    return vibe.handle(new Request(`https://site.test${path}`, { ...init, headers }), env, ctx);
  }
  async function upload() {
    token = (await (await call("/_vibe/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dev: true }) })).json() as any).token;
    const form = new FormData();
    form.set("file", new File([png(1200, 600)], "cover.png", { type: "image/png" }));
    return (await (await call("/_vibe/api/assets", { method: "POST", body: form })).json()) as { id: string, url: string };
  }
  async function warnings() {
    return ((await (await call("/.well-known/vibe-cms")).json()) as { warnings: Array<{ code: string }> }).warnings.map(w => w.code);
  }
  return { env, vibe, call, upload, warnings };
}

describe("image optimization", () => {
  test("a ?w= request is resized to an allowed width in the best accepted format", async () => {
    const images = fakeImages();
    const t = setup(images);
    const asset = await t.upload();
    const response = await t.call(`/_vibe/media/${asset.id}.png?w=700`, { headers: { accept: "image/avif,image/webp,*/*" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/avif");
    expect(response.headers.get("vary")).toBe("Accept");
    expect(await response.text()).toBe("resized:960");
    expect(await t.warnings()).toEqual([]);
  });

  test("URLs without ?w= are served as they are", async () => {
    const images = fakeImages();
    const t = setup(images);
    const asset = await t.upload();
    const response = await t.call(`/_vibe/media/${asset.id}.png`);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(images.calls).toEqual([]);
  });

  test("a failing setup serves the original briefly cached, warns, and clears once it works", async () => {
    const images = fakeImages({ error: "Image transformations are not enabled for this zone" });
    const t = setup(images);
    const asset = await t.upload();
    const response = await t.call(`/_vibe/media/${asset.id}.png?w=640`, { headers: { accept: "image/webp" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await t.warnings()).toEqual(["images.not-enabled"]);

    images.error = undefined;
    const fixed = await t.call(`/_vibe/media/${asset.id}.png?w=640`, { headers: { accept: "image/webp" } });
    expect(await fixed.text()).toBe("resized:640");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await t.warnings()).toEqual([]);
  });

  test("no binding serves originals and warns; images: false opts out quietly", async () => {
    const missing = setup(undefined);
    const asset = await missing.upload();
    const response = await missing.call(`/_vibe/media/${asset.id}.png?w=640`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await missing.warnings()).toEqual(["images.missing-binding"]);

    const off = setup(false);
    await off.upload();
    expect(await off.warnings()).toEqual([]);
  });
});

describe("image helpers", () => {
  test("widths round up to the fixed set and never past the original", () => {
    expect(snapWidth(700, 4000)).toBe(960);
    expect(snapWidth(700, 500)).toBe(500);
    expect(snapWidth(9000, undefined)).toBe(2560);
  });

  test("formats follow Accept", () => {
    expect(pickFormat("image/avif,image/webp", "image/jpeg")).toBe("image/avif");
    expect(pickFormat("image/webp", "image/jpeg")).toBe("image/webp");
    expect(pickFormat("*/*", "image/png")).toBe("image/png");
  });

  test("binding errors sort into actionable problems", () => {
    expect(classifyImageError(new Error("Quota exceeded"))).toBe("quota");
    expect(classifyImageError(new Error("Transformations not enabled"))).toBe("not-enabled");
    expect(classifyImageError(new Error("Bad input"))).toBe("error");
  });

  test("imageUrl keeps ?v= and leaves files it doesn't resize alone", () => {
    expect(imageUrl({ url: "/_vibe/media/ast_1.jpg?v=2", mime: "image/jpeg" }, 640)).toBe("/_vibe/media/ast_1.jpg?v=2&w=640");
    expect(imageUrl({ url: "/a.svg", mime: "image/svg+xml" }, 640)).toBe("/a.svg");
  });
});

describe("img()", () => {
  const photo = { url: "/_vibe/media/ast_1.jpg", mime: "image/jpeg", width: 3000, height: 2000, alt: "A chair", focal: { x: 0.3, y: 0.6 } };

  test("spreads into an <img> with srcSet, sizes, dimensions and lazy loading", () => {
    expect(img(photo)).toEqual({
      src: "/_vibe/media/ast_1.jpg?w=1280",
      srcSet: [320, 640, 960, 1280, 1920, 2560].map(w => `/_vibe/media/ast_1.jpg?w=${w} ${w}w`).join(", "),
      sizes: "100vw",
      width: 3000,
      height: 2000,
      alt: "A chair",
      loading: "lazy",
      decoding: "async"
    });
  });

  test("a pixel width caps the srcSet at what a 2x screen needs", () => {
    const attrs = img(photo, { sizes: 400 });
    expect(attrs.sizes).toBe("(min-width: 400px) 400px, 100vw");
    expect(attrs.srcSet!.split(", ").map(s => s.split(" ")[1])).toEqual(["320w", "640w", "960w"]);
    expect(attrs.src).toBe("/_vibe/media/ast_1.jpg?w=640");
    expect(img(photo, { sizes: 48 }).sizes).toBe("48px");
  });

  test("breakpoint objects become media queries, widest first", () => {
    expect(sizesAttribute({ base: "100vw", md: "50vw", xl: 640 }).attribute).toBe("(min-width: 1280px) 640px, (min-width: 768px) 50vw, 100vw");
    expect(sizesAttribute({ base: "100vw", tablet: "50vw" }, { tablet: 700 }).attribute).toBe("(min-width: 700px) 50vw, 100vw");
    expect(() => sizesAttribute({ base: "100vw", huge: 9 })).toThrow(/unknown breakpoint "huge"/);
  });

  test("small originals end the srcSet at their own width; SVGs get none", () => {
    expect(img({ ...photo, width: 700 }).srcSet).toBe("/_vibe/media/ast_1.jpg?w=320 320w, /_vibe/media/ast_1.jpg?w=640 640w, /_vibe/media/ast_1.jpg?w=700 700w");
    expect(img({ url: "/logo.svg", mime: "image/svg+xml" })).toEqual({ src: "/logo.svg", alt: "", loading: "lazy", decoding: "async" });
  });

  test("priority, alt and field", () => {
    expect(img(photo, { priority: true, alt: "Override", field: "post:1:cover" })).toMatchObject({
      loading: "eager", decoding: "auto", fetchPriority: "high", alt: "Override", "data-vibe-field": "post:1:cover"
    });
  });

  test("focus() and the HTML form", () => {
    expect(focus(photo)).toBe("30% 60%");
    expect(focus({})).toBe("50% 50%");
    expect(imgTag(img({ url: "/a.jpg", mime: "image/jpeg", alt: "Say \"hi\"" }, { priority: true }))).toContain("srcset=\"/a.jpg?w=320 320w");
    expect(imgTag(img({ url: "/a.jpg", alt: "Say \"hi\"" }))).toContain("alt=\"Say &quot;hi&quot;\"");
  });
});
