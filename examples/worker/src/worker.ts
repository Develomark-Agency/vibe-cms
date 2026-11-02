import { eq } from "vibe-cms/query";
import { post, vibe } from "./cms.ts";

// `/_vibe/*` goes to the CMS; everything else to this `fetch`. The cron trigger runs scheduled publishing.
export default vibe({
  async fetch(request, env) {
    const cms = vibe.client(env);
    const { pathname } = new URL(request.url);

    if(pathname === "/") {
      const posts = await cms.query(post).findMany({ limit: 20 });
      const items = posts.map(p => `<li><a href="/posts/${p.slug}">${escape(p.title)}</a></li>`).join("");
      return html(`<h1>Posts</h1><ul>${items}</ul><p><a href="/_vibe/admin/">Editor</a></p>`);
    }

    const slug = /^\/posts\/([\w-]+)$/.exec(pathname)?.[1];
    if(slug) {
      const entry = await cms.query(post).findFirst({ where: eq(post.slug, slug) });
      if(entry) return html(`<h1>${escape(entry.title)}</h1><p>${escape(entry.body)}</p>`);
    }

    return new Response("Not found", { status: 404 });
  }
});

function html(body: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8">${body}`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, char => `&#${char.charCodeAt(0)};`);
}
