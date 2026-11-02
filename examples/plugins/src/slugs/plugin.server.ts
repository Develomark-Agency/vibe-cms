import { defineServer } from "vibe-cms/server";
import type config from "../../vibe-cms.config.ts";
import type { SlugsPlugin } from "./index.ts";

function slugify(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-");
}

// `typeof config` types the documents in hooks against the site's own schemas.
export default defineServer<typeof SlugsPlugin, typeof config>(() => ({
  // Runs before validation, on raw input: fill a required field the editor left empty.
  "content.beforeValidate": (input, output) => {
    const { doc } = output;
    if(input.type === "post" && !doc.slug && typeof doc.title === "string") doc.slug = slugify(doc.title);
  },
  // Runs after validation: `output.valid` narrows `output.doc` to a typed post.
  "content.beforeWrite": (_input, output) => {
    if(output.type !== "post" || !output.valid) return;
    output.doc.wordCount = output.doc.body.split(/\s+/).filter(Boolean).length;
  }
}));
