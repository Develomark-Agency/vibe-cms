import { createClient } from "vibe-cms/client";
import config from "../../worker/vibe-cms.config.ts";

const url = process.env.SITE_URL ?? "http://localhost:1340";

// Drafts need a site session token. Development sites hand one to anyone who asks.
async function devToken(): Promise<string> {
  const response = await fetch(`${url}/_vibe/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dev: true })
  });
  return (await response.json() as { token: string }).token;
}

const cms = createClient<typeof config>({ url, token: process.env.VIBE_TOKEN ?? await devToken() });

// Working copies, including documents that were never published.
const drafts = await cms.query(config.schemas.post, { drafts: true }).findMany();
console.log(drafts.map(entry => `${entry.title} (${entry.$meta.status})`));
