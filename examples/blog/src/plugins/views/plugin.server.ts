import { toPlainText } from "vibe-cms/rich-text";
import { defineServer } from "vibe-cms/server";
import type config from "../../../vibe-cms.config.ts";
import type { ViewsPlugin } from "./index.ts";

// A site's own plugin can know the site's content types: hooks are typed against `config`.
export default defineServer<typeof ViewsPlugin, typeof config>(({ bindings, options, log }) => {
  const types = options.types ?? ["post"];
  function counter(id: string) {
    return bindings.counters.get(bindings.counters.idFromName(id));
  }
  return {
    // transform: derive a field. It's declared in the schema (read-only in the editor).
    "content.beforeWrite": (_input, output) => {
      if(output.type !== "post" || !output.valid) return;
      const words = toPlainText(output.doc.body).split(/\s+/).filter(Boolean).length;
      output.doc.readingMinutes = Math.max(1, Math.round(words / 220));
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
