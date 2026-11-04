import { router } from "./define.ts";
import { assets } from "./core/assets.ts";
import { backups } from "./core/backups.ts";
import { documents } from "./core/documents.ts";
import { folders } from "./core/folders.ts";
import { schema } from "./core/schema.ts";
import { site } from "./core/site.ts";
import { trash } from "./core/trash.ts";

/** Every built-in action, in groups: `documents.list` is `coreActions.documents.list`. Surfaces are generated from this tree. */
export const coreActions = router({
  schema,
  documents,
  assets,
  folders,
  trash,
  site,
  backups
});

export type CoreActions = typeof coreActions;
