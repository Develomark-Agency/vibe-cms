import { defineAction, defineServer } from "vibe-cms/server";
import { z } from "zod";
import config from "../../vibe-cms.config.ts";
import type { NewsletterPlugin } from "./index.ts";

const { post } = config.schemas;

export default defineServer<typeof NewsletterPlugin, typeof config>(({ bindings, cms, can }) => ({
  routes: {
    // The key itself never leaves the Worker: people who may see it get whether it's set and its last four characters.
    "GET /key": async (_request, { session }) => {
      if(!can(session, "apiKey")) return Response.json({ error: "Not allowed" }, { status: 403 });
      const key = await bindings.settings.get("apiKey");
      return Response.json({ set: key !== null, ending: key?.slice(-4) ?? null });
    },
    "PUT /key": async (request, { session }) => {
      if(!can(session, "apiKey", "edit")) return Response.json({ error: "Not allowed" }, { status: 403 });
      const { key } = await request.json() as { key?: string };
      if(!key) return Response.json({ error: "Expected a key" }, { status: 400 });
      await bindings.settings.put("apiKey", key);
      return new Response(null, { status: 204 });
    }
  },
  actions: {
    // `permit` names one of the plugin's own permissions: checked before the handler runs.
    send: defineAction({
      summary: "Send a newsletter",
      description: "Emails a published post to every subscriber.",
      permit: { permission: "send" },
      input: z.object({ id: z.string().describe("The post's ID") }),
      handler: async ({ input }) => {
        const key = await bindings.settings.get("apiKey");
        if(!key) throw new Error("Set the newsletter's API key first");
        const found = await cms.query(post).findById(input.id);
        if(!found) throw new Error("No published post with that ID");
        const response = await fetch("https://newsletter.example/v1/send", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ subject: found.title, text: found.body })
        });
        return { sent: response.ok };
      }
    })
  }
}));
