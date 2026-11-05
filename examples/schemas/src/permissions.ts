import { defineConfig, type RoleRules } from "vibe-cms";
import v from "vibe-cms/schema";

// Editors, the CLI and agents sign in through the org's hub (panel): deploy the site with
// VIBE_ORG=my-agency.com. Who may do what isn't in this file either: roles are stored in the
// site's database and edited on the editor's Roles page. Development sites don't need any.
export default defineConfig({
  schemas: {
    post: v.object({ title: v.text() }),
    page: v.object({ title: v.text() })
  }
});

// What the Roles page stores for each role, and what `PUT /_vibe/api/roles/:name` and hub
// templates take: rules by content type, plus a few switches.
export const roles: Record<string, RoleRules> = {
  admin: { all: true },
  editor: {
    "*": ["read"],
    post: ["read", "write", "publish", "delete"],
    page: ["read", "write"],
    media: ["read", "write"],
    siteSettings: true
  },
  // Writes posts but can't publish them.
  contributor: { post: ["read", "write"], media: ["read", "write"], publish: false }
};
