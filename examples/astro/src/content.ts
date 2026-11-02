import { env } from "cloudflare:workers";
import { post, vibe } from "./cms.ts";

// In-process reads for pages: no HTTP round trip, published content only.
export const cms = vibe.client(env);
export { post };
