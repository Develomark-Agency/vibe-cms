import { definePlugin } from "vibe-cms";
import type { Counter } from "./counter.server.ts";

export { Counter } from "./counter.server.ts";

/**
 * Counts hits per document in a Durable Object. The class has to be exported
 * from the Worker entry; `exports` makes `export * from "vibe-cms/exports"` do that.
 */
export const CounterPlugin = definePlugin<{
  counters: DurableObjectNamespace<Counter>
}>()(() => ({
  name: "counter",
  options: {},
  server: () => import("./plugin.server.ts"),
  exports: { from: import.meta.url, names: ["Counter"] }
}));
