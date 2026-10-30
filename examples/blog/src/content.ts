import { env } from "cloudflare:workers";
import config from "../vibe-cms.config.ts";
import { vibe } from "./cms.ts";

export const cms = vibe.client(env);
export const { post, author, homepage } = config.schemas;

export type Locale = typeof config.locales[number];

/** `?lang=fr` → `"fr"`, if it's one of the site's locales. */
export function localeFrom(url: URL): Locale | undefined {
  const lang = url.searchParams.get("lang");
  return config.locales.find(locale => locale === lang);
}

/** Name and accent from the editor's Site settings, tagline from the homepage content. */
export async function siteSettings() {
  const [site, home] = await Promise.all([vibe.site(env), cms.query(homepage).findFirst()]);
  return { title: site.name, accent: site.accent ?? "#c2410c", icon: site.icon?.url, tagline: home?.tagline };
}
