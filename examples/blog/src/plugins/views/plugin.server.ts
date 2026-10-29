import { defineServer } from "vibe-cms/server";
import type { ViewsPlugin } from "./index.ts";

function words(value: unknown): number {
  if(typeof value === "string") return value.split(/\s+/).filter(Boolean).length;
  if(Array.isArray(value)) return value.reduce((n: number, item) => n + words(item), 0);
  if(value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    return words(node.text) + words(node.children) + words(node.items);
  }
  return 0;
}

export default defineServer<typeof ViewsPlugin>(({ bindings, options, log }) => {
  const types = options.types ?? ["post"];
  function counter(id: string) {
    return bindings.counters.get(bindings.counters.idFromName(id));
  }
  return {
    // transform: derive a field the schema doesn't have to know about
    "content.beforeWrite": ({ type }, output) => {
      if(type === "post") output.doc.readingMinutes = Math.max(1, Math.round(words(output.doc.body) / 220));
    },
    // observe
    "content.afterWrite": ({ type, id, action }) => {
      if(action === "publish") log.info(`views: ${type} ${id} published`);
    },
    routes: {
      "POST /hit/:id": async (_request, { params }) => Response.json({ views: await counter(params.id!).hit() }),
      "GET /views/:id": async (_request, { params, session }) => {
        if(!session) return Response.json({ error: "Sign in required" }, { status: 401 });
        return Response.json({ views: await counter(params.id!).views() });
      },
      "GET /types": () => Response.json({ types })
    }
  };
});
