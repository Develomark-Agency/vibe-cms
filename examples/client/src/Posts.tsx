import { createClient } from "vibe-cms/client";
import { desc } from "vibe-cms/query";
import { useContent } from "vibe-cms/react";
import config from "../../worker/vibe-cms.config.ts";

const cms = createClient<typeof config>({ url: "https://example.com" });
const { post } = config.schemas;

// Runs both queries once, batched into one request, when the component mounts.
export function Posts() {
  const content = useContent(cms, q => ({
    posts: q(post).findMany({ orderBy: [desc(post.title)], limit: 10 }),
    total: q(post).count()
  }));
  if(content.loading) return <p>Loading…</p>;
  if(content.error) return <p>{content.error.message} <button onClick={content.refresh}>Retry</button></p>;
  return (
    <>
      <p>{content.data.total} posts</p>
      <ul>{content.data.posts.map(entry => <li key={entry.id}>{entry.title}</li>)}</ul>
    </>
  );
}
