import { definePlugin } from "vibe-cms";

/** Adds to the editor's own screens: document sidebar and actions, list columns, commands, field decorators. */
export const EditorPlugin = definePlugin()(() => ({
  name: "editor",
  options: {},
  admin: () => import("./plugin.admin.tsx")
}));
