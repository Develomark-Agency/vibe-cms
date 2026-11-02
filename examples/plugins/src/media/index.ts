import { definePlugin } from "vibe-cms";

export interface MediaOptions {
  /** Largest upload in bytes, for anything that isn't an image. */
  maxSize: number
}

/** Checks and renames uploads, and records extra metadata for text files. */
export const MediaPlugin = definePlugin()((options: MediaOptions) => ({
  name: "media",
  options,
  server: () => import("./plugin.server.ts")
}));
