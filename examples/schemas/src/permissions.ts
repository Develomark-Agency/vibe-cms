import { defineConfig } from "vibe-cms";
import { hub } from "vibe-cms/auth";
import v from "vibe-cms/schema";

export default defineConfig({
  // Editors, the CLI and agents sign in through the agency's hub (panel). Development sites don't need it.
  auth: hub({
    url: "https://edit.my-agency.com",
    // Optional: read roles from this identity provider claim as well; the hub passes it through.
    roles: "groups"
  }),
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
    // Roles by verified email (or `<issuer>|<sub>`), on top of any from the `roles` claim.
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
