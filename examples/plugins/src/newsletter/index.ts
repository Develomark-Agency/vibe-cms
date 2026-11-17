import { definePlugin } from "vibe-cms";

/**
 * Sends published posts to a newsletter service, with its API key kept behind the plugin's own
 * permissions. The site supplies a KV namespace for the key under `newsletter`.
 */
export const NewsletterPlugin = definePlugin<{ settings: KVNamespace }>()(() => ({
  name: "newsletter",
  options: {},
  // Shown on the Roles page under the plugin. Nobody but owners and `all` roles has them until a role gives them.
  permissions: {
    // Levels, lowest first: each includes the ones before it.
    apiKey: { label: "API key", description: "See whether the key is set, or change it", levels: ["view", "edit"] },
    // Yes or no.
    send: { label: "Send newsletters", description: "Email a published post to every subscriber" }
  },
  server: () => import("./plugin.server.ts"),
  admin: () => import("./plugin.admin.tsx")
}));
