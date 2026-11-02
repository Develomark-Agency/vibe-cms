import { defineServer } from "vibe-cms/server";
import type { MediaPlugin } from "./index.ts";

export default defineServer<typeof MediaPlugin>(({ options }) => ({
  // Before anything is stored: rename, choose the folder, or refuse with `reject` (the API answers 422).
  "media.beforeUpload": (input, output) => {
    if(!input.mime.startsWith("image/") && input.size > options.maxSize) {
      output.reject = `Files other than images can be at most ${options.maxSize / 1_000_000} MB`;
      return;
    }
    output.filename = output.filename.toLowerCase().replace(/\s+/g, "-");
    output.folder ??= input.mime.startsWith("image/") ? "images" : "files";
  },
  // Metadata extractors by MIME pattern. They get the file's first 256 KB; what they return is merged into the asset's `meta`.
  "media.analyze": {
    "text/*": bytes => ({ lines: new TextDecoder().decode(bytes).split("\n").length })
  }
}));
