import { definePlugin } from "vibe-cms";

export interface WebhookOptions {
  /** Content types that trigger the webhook. Defaults to all. */
  types?: string[]
}

/**
 * Posts to a URL when documents are published or unpublished. The type
 * argument is the binding contract: the site supplies `{ url }` in
 * `createHandler({ bindings })`, under the plugin's name.
 */
export const WebhookPlugin = definePlugin<{ url: string }>()((options: WebhookOptions = {}) => ({
  name: "webhook",
  options,
  server: () => import("./plugin.server.ts")
}));
