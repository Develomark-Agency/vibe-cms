import { defineConfig } from "vibe-cms";
import { oidc } from "vibe-cms/auth";
import v from "vibe-cms/schema";

export default defineConfig({
  // Editors sign in through the agency panel with this identity provider. Development sites don't need it.
  auth: oidc({
    issuer: "https://accounts.google.com",
    clientId: "1234.apps.googleusercontent.com",
    // Optional: read roles from this ID token claim as well.
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
