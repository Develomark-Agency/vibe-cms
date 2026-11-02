import { defineServer } from "vibe-cms/server";
import type { CounterPlugin } from "./index.ts";

export default defineServer<typeof CounterPlugin>(({ bindings }) => ({
  routes: {
    // Public: POST /_vibe/plugins/counter/hit/<id> from the site's pages.
    "POST /hit/:id": async (_request, { params }) => {
      const counter = bindings.counters.get(bindings.counters.idFromName(params.id!));
      return Response.json({ hits: await counter.hit() });
    }
  }
}));
