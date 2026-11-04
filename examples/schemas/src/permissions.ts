import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

// Editors, the CLI and agents sign in through the org's hub (panel): deploy the site with
// VIBE_ORG=my-agency.com. Sign-in is the org's choice, so nothing about it lives in this file.
// Development sites don't need it.
export default defineConfig({
  permissions: {
    roles: {
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
    },
    // Roles by verified email (or `<issuer>|<sub>`), on top of any the hub passes on from the
    // identity provider (its OIDC_ROLES_CLAIM, e.g. "groups").
    users: {
      "ada@agency.example": ["admin"],
      "sam@client.example": ["editor"]
    }
  },
  schemas: {
    post: v.object({ title: v.text() }),
    page: v.object({ title: v.text() })
  }
});
