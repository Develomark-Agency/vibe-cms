import { z } from "zod";
import { base, router } from "../define.ts";
import { folder, limit, offset } from "./fields.ts";

const assetId = z.string().describe("Asset ID");

const assetsList = base({
  summary: "List files",
  description: "Files in the media library, newest first. `folder: \"\"` lists the root only; omit it for every folder.",
  readOnly: true
})
  .input(z.object({
    folder: z.string().optional(),
    search: z.string().optional().describe("Matches file names"),
    accept: z.array(z.string()).optional().describe("MIME types, wildcards allowed, e.g. image/*"),
    limit,
    offset
  }))
  .handler(({ context: { engine }, input }) => engine.listAssets({ ...input, limit: input.limit ?? 60, offset: input.offset ?? 0 }));

const assetsGet = base({
  summary: "Get a file",
  description: "A file's details and the documents that use it.",
  readOnly: true
})
  .input(z.object({ id: assetId }))
  .handler(({ context: { engine }, input }) => engine.getAsset(input.id));

const assetsUpload = base({
  summary: "Upload a file",
  description: "Adds a file to the media library. Pass `type` and `field` to check it against that asset field (accepted types, size, image dimensions). Use the returned `id` as `{ asset: id }` in documents."
})
  .input(z.object({
    file: z.file(),
    folder: z.string().optional(),
    type: z.string().optional().describe("Content type whose field the file is for"),
    field: z.string().optional().describe("Dot path of that asset field, e.g. cover")
  }))
  .handler(({ context: { engine }, input }) => engine.upload(input.file, { folder: input.folder || undefined, type: input.type || undefined, field: input.field || undefined }));

const assetsUpdate = base({
  summary: "Rename or move a file",
  description: "Changes a file's name or folder. `folder: null` moves it to the root.",
  idempotent: true
})
  .input(z.object({
    id: assetId,
    filename: z.string().optional(),
    folder: folder.nullable().optional()
  }))
  .handler(({ context: { engine }, input }) => engine.updateAsset(input.id, { filename: input.filename, folder: input.folder }));

const assetsReplaceContent = base({
  summary: "Edit a text file",
  description: "Replaces a text file's content (up to 1 MB). The file keeps its ID, so documents using it see the new content.",
  idempotent: true
})
  .input(z.object({
    id: assetId,
    content: z.string()
  }))
  .handler(({ context: { engine }, input }) => engine.replaceContent(input.id, new TextEncoder().encode(input.content).buffer as ArrayBuffer));

const assetsDelete = base({
  summary: "Delete a file",
  description: "Moves a file to the trash. Fails with CONFLICT while a document uses it."
})
  .input(z.object({ id: assetId }))
  .handler(({ context: { engine }, input }) => engine.deleteAsset(input.id));

export const assets = router({
  list: assetsList,
  get: assetsGet,
  upload: assetsUpload,
  update: assetsUpdate,
  replaceContent: assetsReplaceContent,
  delete: assetsDelete
});
