import { createContext, useContext, type Context } from "react";
import type { AnyConfig, Collection, CollectionSettings } from "../../config.ts";
import type { ObjectSchema } from "../../schema/types.ts";
import type { AdminClient, AdminPlugin } from "../index.ts";
import type { DocumentData } from "../../schema/types.ts";
import type { SiteSettings } from "../../handler/engine.ts";
import type { SessionState, SiteInfo } from "./client.ts";
import { titleField } from "../../title.ts";

export { titleField };

export interface AdminContextValue {
  config: AnyConfig,
  info: SiteInfo,
  /** Name, accent and icon, kept current after edits in the settings page. */
  site: SiteSettings,
  session: SessionState,
  cms: AdminClient,
  plugins: Required<AdminPlugin>,
  locale: string,
  setLocale(locale: string): void
}

/**
 * Shared across module copies. A bundler can load this file twice (Vite pre-bundling `vibe-cms/media`
 * and its lazy widgets in a consuming project), and two contexts would leave one copy without a provider.
 */
export function sharedContext<T>(key: string, initial: T): Context<T> {
  const registry = globalThis as unknown as Record<symbol, Context<T> | undefined>;
  const symbol = Symbol.for(key);
  return registry[symbol] ??= createContext<T>(initial);
}

export const AdminContext = sharedContext<AdminContextValue | null>("vibe-cms:admin-context", null);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if(!value) throw new Error("useAdmin outside the admin app");
  return value;
}

export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function pluralize(word: string): string {
  if(/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if(/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

export function collectionSchema(config: AnyConfig, type: string): ObjectSchema {
  const collection = (config.schemas as Record<string, Collection | undefined>)[type];
  if(!collection) throw new Error(`Unknown content type "${type}"`);
  return collection["~collection"].schema;
}

export function collectionSettings(config: AnyConfig, type: string): CollectionSettings {
  return config.collections?.[type] ?? {};
}

export function collectionLabel(config: AnyConfig, type: string, plural = true): string {
  const settings = collectionSettings(config, type);
  if(settings.label) return settings.label;
  const label = humanize(type);
  return plural && !settings.singleton ? pluralize(label) : label;
}

export function documentTitle(config: AnyConfig, type: string, doc: DocumentData | null | undefined): string {
  const field = titleField(config, type);
  const value = field ? doc?.[field] : undefined;
  return typeof value === "string" && value.trim() ? value : "Untitled";
}

export function localeName(locale: string): string {
  try {
    return new Intl.DisplayNames([navigator.language, "en"], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export function formatRelative(date: string | number | null | undefined): string {
  if(date === null || date === undefined) return "—";
  const ms = typeof date === "number" ? date : Date.parse(date);
  const diff = (ms - Date.now()) / 1000;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60]
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for(const [unit, seconds] of units) {
    if(Math.abs(diff) >= seconds) return rtf.format(Math.round(diff / seconds), unit);
  }
  // Under a minute: past times stay "just now", but an upcoming time is not "now" yet.
  if(diff > 0) return rtf.format(Math.max(1, Math.round(diff)), "second");
  return "just now";
}

export function formatDate(date: string | number | null | undefined): string {
  if(date === null || date === undefined) return "—";
  return new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** `https://accounts.google.com|10498…` → something readable. */
export function displayUser(sub: string | null | undefined, session?: SessionState): string {
  if(!sub) return "—";
  if(session && sub === session.user.sub) return "You";
  if(sub === "dev") return "Local developer";
  if(sub === "system") return "Scheduled";
  return sub.split("|").pop()!.slice(0, 12);
}
