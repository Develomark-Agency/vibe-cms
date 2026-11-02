/**
 * Re-exports the Durable Object and Workflow classes plugins declare with `exports`, for the Worker entry:
 * `export * from "vibe-cms/exports";`. The `vibe()` Vite plugin replaces this module; without it, importing throws.
 */
throw new Error(
  "vibe-cms/exports requires the vibe() Vite plugin. "
  + "Add it to vite.config.ts, or export plugin classes manually."
);

export {};
