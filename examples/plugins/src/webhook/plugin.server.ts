import { defineServer } from "vibe-cms/server";
import type { WebhookPlugin } from "./index.ts";

export default defineServer<typeof WebhookPlugin>(({ bindings, options, log }) => ({
  // Observes: runs after the response is sent (through `waitUntil`); errors are logged, never returned.
  "content.afterWrite": async ({ type, id, locale, action }) => {
    if(action !== "publish" && action !== "unpublish") return;
    if(options.types && !options.types.includes(type)) return;
    const response = await fetch(bindings.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, id, locale, action })
    });
    if(!response.ok) log.warn(`webhook: ${bindings.url} answered ${response.status}`);
  }
}));
