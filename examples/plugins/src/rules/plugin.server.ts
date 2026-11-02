import { defineServer } from "vibe-cms/server";
import config from "../../vibe-cms.config.ts";
import type { RulesPlugin } from "./index.ts";

const { post } = config.schemas;

export default defineServer<typeof RulesPlugin, typeof config>(({ options, cms }) => ({
  // Throwing rejects the write: the API answers 422 with the message.
  "content.beforeWrite": (input, output) => {
    if(input.action !== "publish" || output.type !== "post" || !output.valid) return;
    const word = options.blockedWords.find(w => output.doc.title.includes(w));
    if(word) throw new Error(`Remove "${word}" from the title before publishing`);
  },
  // Setting `cancel` blocks the delete: the API answers 409 with the message.
  "content.beforeDelete": async (input, output) => {
    if(input.type !== "post") return;
    // Server plugins may read drafts: the in-process client is trusted.
    const doc = await cms.query(post, { drafts: true }).findById(input.id);
    if(doc?.pinned) output.cancel = "Unpin this post before deleting it";
  }
}));
