import { z } from "zod";
import { base, router } from "../define.ts";

const trashId = z.string().describe("Trash item ID, from `trash.list`");

const trashList = base({
  summary: "List the trash",
  description: "Deleted documents, translations and files this user may restore, newest first, and how many days they're kept.",
  readOnly: true
})
  .handler(({ context: { engine } }) => engine.listTrash());

const trashGet = base({
  summary: "Get a trashed item",
  description: "A deleted document's fields in each language, or a deleted file's details.",
  readOnly: true
})
  .input(z.object({ id: trashId }))
  .handler(({ context: { engine }, input }) => engine.trashDetail(input.id));

const trashRestore = base({
  summary: "Restore from the trash",
  description: "Puts a document or file back as it was, published state included. Files the document used come back with it."
})
  .input(z.object({ id: trashId }))
  .handler(({ context: { engine }, input }) => engine.restoreTrash(input.id));

const trashPurge = base({
  summary: "Delete permanently",
  description: "Deletes a trashed item for good, with its version history or the file's content. Can't be undone.",
  destructive: true
})
  .input(z.object({ id: trashId }))
  .handler(({ context: { engine }, input }) => engine.purgeTrash(input.id));

const trashEmpty = base({
  summary: "Empty the trash",
  description: "Permanently deletes everything in the trash this user may delete. Can't be undone.",
  destructive: true
})
  .handler(({ context: { engine } }) => engine.emptyTrash());

export const trash = router({
  list: trashList,
  get: trashGet,
  restore: trashRestore,
  purge: trashPurge,
  empty: trashEmpty
});
