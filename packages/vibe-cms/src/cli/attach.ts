import { styleText } from "node:util";
import { hubPost } from "./login.ts";

export interface AttachOptions {
  link: string,
  /** A role template's id, `none` for no starting roles, or undefined for the panel's default. */
  template?: string,
  /** Where to log in when this project has no login yet: the org's domain, or the panel's URL. */
  hub?: string,
  headless?: boolean
}

interface Attached {
  id: string,
  name: string,
  url: string,
  template?: { state: string, skipped?: string[], error?: string } | null
}

/**
 * `vibe-cms admin attach <link>`: gives a site's claim link to the panel, which tells the site its org
 * and adds it. The panel does the work as the logged-in user, so who may add sites is its call.
 */
export async function attach(options: AttachOptions, post: typeof hubPost = hubPost): Promise<Attached> {
  const response = await post("/site-attach", {
    link: options.link,
    ...options.template === undefined ? {} : { templateId: options.template === "none" ? null : options.template }
  }, { hub: options.hub, headless: options.headless });
  const data = await response.json().catch(() => ({})) as Partial<Attached> & { error?: string };
  if(!response.ok) throw new Error(data.error ?? `The panel answered ${response.status}`);
  return data as Attached;
}

/** What to tell the person once a site is attached. */
export function describeAttached(site: Attached): string[] {
  const lines = [`  ${styleText("green", "✓")} ${styleText("bold", "Attached")} ${site.name} ${styleText("dim", `(${site.url})`)}`];
  const template = site.template;
  if(template?.state === "pending") lines.push(styleText("yellow", "  Its starting roles will be written once the site can be reached."));
  else if(template?.state === "failed") lines.push(styleText("yellow", `  Its starting roles couldn't be written: ${template.error}`));
  else if(template?.skipped?.length) lines.push(styleText("yellow", `  ${template.skipped.length} role ${template.skipped.length === 1 ? "rule" : "rules"} skipped: ${template.skipped.join("; ")}`));
  return lines;
}
