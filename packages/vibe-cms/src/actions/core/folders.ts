import { z } from "zod";
import { base, router } from "../define.ts";
import { folder } from "./fields.ts";

const foldersList = base({
  summary: "List folders",
  description: "Every media folder with the number of files directly in it.",
  readOnly: true
})
  .handler(async ({ context: { engine } }) => ({ folders: await engine.listFolders() }));

const foldersCreate = base({
  summary: "Create a folder",
  description: "Creates a media folder, and its parents.",
  idempotent: true
})
  .input(z.object({ path: folder }))
  .handler(({ context: { engine }, input }) => engine.createFolder(input.path));

const foldersMove = base({
  summary: "Rename or move a folder",
  description: "Moves a folder with its files and subfolders."
})
  .input(z.object({
    from: folder,
    to: folder
  }))
  .handler(({ context: { engine }, input }) => engine.moveFolder(input.from, input.to));

const foldersDelete = base({
  summary: "Delete a folder",
  description: "Deletes an empty folder and its empty subfolders."
})
  .input(z.object({ path: folder }))
  .handler(({ context: { engine }, input }) => engine.deleteFolder(input.path));

export const folders = router({
  list: foldersList,
  create: foldersCreate,
  move: foldersMove,
  delete: foldersDelete
});
