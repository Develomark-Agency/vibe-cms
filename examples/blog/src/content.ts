import { env } from "cloudflare:workers";
import config from "../vibe-cms.config.ts";
import { vibe } from "./cms.ts";

export const cms = vibe.client(env);
export const { post, author, settings } = config.schemas;

export type Locale = typeof config.locales[number];

/** `?lang=fr` → `"fr"`, if it's one of the site's locales. */
export function localeFrom(url: URL): Locale | undefined {
  const lang = url.searchParams.get("lang");
  return config.locales.find(locale => locale === lang);
}

export async function siteSettings() {
  return (await cms.query(settings).findFirst()) ?? { title: "Vibe Blog", tagline: undefined, accent: "#6d28d9" };
}
