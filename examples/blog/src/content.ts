import { env } from "cloudflare:workers";
import config from "../vibe-cms.config.ts";
import { vibe } from "./cms.ts";

export const cms = vibe.client(env);
export const { post, author, settings } = config.schemas;
export const locales = config.locales;

export async function siteSettings() {
  return (await cms.query(settings).findFirst()) ?? { title: "Vibe Blog", tagline: undefined, accent: "#6d28d9" };
}
