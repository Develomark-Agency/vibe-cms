import { describe, expect, test } from "bun:test";
import { readMetadata, stripMetadata } from "../src/media/metadata.ts";
import { analyzeImage } from "../src/handler/analyze.ts";

/** A big-endian TIFF IFD0 with the given SHORT/LONG tags. */
function tiff(entries: Array<[tag: number, value: number]>): number[] {
  const out = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, entries.length];
  for(const [tag, value] of entries) out.push(tag >> 8, tag & 0xff, 0, 3, 0, 0, 0, 1, value >> 8, value & 0xff, 0, 0);
  out.push(0, 0, 0, 0);
  return out;
}

const GPS = 0x8825, MAKE = 0x010f, ORIENTATION = 0x0112;

/** SOI, an Exif APP1, a comment, a 40×30 SOF0, then SOS and EOI. */
function jpeg(exif: number[]): Uint8Array<ArrayBuffer> {
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...exif];
  const comment = [...new TextEncoder().encode("shot on a phone")];
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff, ...app1,
    0xff, 0xfe, 0, comment.length + 2, ...comment,
    0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 1, 1, 0x11, 0,
    0xff, 0xda, 0, 2, 0xaa, 0xbb,
    0xff, 0xd9
  ]);
}

describe("photo metadata", () => {
  test("finds location, camera and orientation in a JPEG", () => {
    expect(readMetadata(jpeg(tiff([[ORIENTATION, 6], [MAKE, 0], [GPS, 0]])), "image/jpeg")).toEqual({ location: true, camera: true, any: true, orientation: 6 });
  });

  test("stripping keeps orientation and the image, drops the rest", () => {
    const original = jpeg(tiff([[ORIENTATION, 6], [MAKE, 0], [GPS, 0]]));
    const stripped = stripMetadata(original, "image/jpeg")!;
    expect(readMetadata(stripped, "image/jpeg")).toEqual({ location: false, camera: false, any: true, orientation: 6 });
    expect(new TextDecoder().decode(stripped)).not.toContain("shot on a phone");
    expect(analyzeImage(stripped, "image/jpeg")).toEqual({ width: 40, height: 30 });
    // Everything from start-of-scan on is copied as it was.
    expect(Array.from(stripped.slice(-8))).toEqual(Array.from(original.slice(-8)));
  });

  test("photos without metadata are left alone", () => {
    const plain = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 1, 1, 0x11, 0, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
    expect(readMetadata(plain, "image/jpeg").any).toBe(false);
    expect(stripMetadata(plain, "image/jpeg")).toBeNull();
  });
});

describe("uploads", () => {
  test("photos lose their details by default, and keep them when asked", async () => {
    const { createHandler } = await import("../src/handler/index.ts");
    const { config, roles } = await import("./fixture.ts");
    const { createD1, createR2, ctx } = await import("./helpers.ts");
    const env = { DB: createD1({ roles }), MEDIA: createR2() };
    const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA, images: false }) });
    const session = await vibe.handle(new Request("https://site.test/_vibe/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dev: true }) }), env, ctx);
    const token = ((await session.json()) as { token: string }).token;
    async function upload(extra: Record<string, string> = {}) {
      const form = new FormData();
      form.set("file", new File([jpeg(tiff([[GPS, 0]]))], "trip.jpg", { type: "image/jpeg" }));
      for(const [key, value] of Object.entries(extra)) form.set(key, value);
      const response = await vibe.handle(new Request("https://site.test/_vibe/api/assets", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }), env, ctx);
      const asset = (await response.json()) as { id: string, meta: { metadataRemoved?: boolean } };
      return { asset, stored: readMetadata(env.MEDIA.objects.get(`assets/${asset.id}`)!.data, "image/jpeg") };
    }
    const cleaned = await upload();
    expect(cleaned.asset.meta.metadataRemoved).toBe(true);
    expect(cleaned.stored.location).toBe(false);
    const kept = await upload({ stripMetadata: "false" });
    expect(kept.asset.meta.metadataRemoved).toBeUndefined();
    expect(kept.stored.location).toBe(true);

    // The site's setting is the default when an upload doesn't say.
    const patch = await vibe.handle(new Request("https://site.test/_vibe/api/site", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ stripMetadata: false })
    }), env, ctx);
    expect(((await patch.json()) as { stripMetadata: boolean }).stripMetadata).toBe(false);
    expect((await upload()).stored.location).toBe(true);
    expect((await upload({ stripMetadata: "true" })).stored.location).toBe(false);
  });
});

describe("removing details after upload", () => {
  test("strips the stored file in place and gives it a new URL", async () => {
    const { createHandler } = await import("../src/handler/index.ts");
    const { config, roles } = await import("./fixture.ts");
    const { createD1, createR2, ctx } = await import("./helpers.ts");
    const env = { DB: createD1({ roles }), MEDIA: createR2() };
    const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA, images: false }) });
    const session = await vibe.handle(new Request("https://site.test/_vibe/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dev: true }) }), env, ctx);
    const auth = { authorization: `Bearer ${((await session.json()) as { token: string }).token}` };
    const form = new FormData();
    form.set("file", new File([jpeg(tiff([[GPS, 0], [ORIENTATION, 6]]))], "trip.jpg", { type: "image/jpeg" }));
    form.set("stripMetadata", "false");
    const uploaded = (await (await vibe.handle(new Request("https://site.test/_vibe/api/assets", { method: "POST", headers: auth, body: form }), env, ctx)).json()) as { id: string, url: string };
    expect(readMetadata(env.MEDIA.objects.get(`assets/${uploaded.id}`)!.data, "image/jpeg").location).toBe(true);

    const response = await vibe.handle(new Request(`https://site.test/_vibe/api/assets/${uploaded.id}/metadata`, { method: "DELETE", headers: auth }), env, ctx);
    const stripped = (await response.json()) as { url: string, meta: { metadataRemoved?: boolean } };
    expect(stripped.meta.metadataRemoved).toBe(true);
    expect(stripped.url).not.toBe(uploaded.url);
    expect(stripped.url).toContain("?v=1");
    const stored = readMetadata(env.MEDIA.objects.get(`assets/${uploaded.id}`)!.data, "image/jpeg");
    expect(stored).toMatchObject({ location: false, orientation: 6 });
  });
});
