import { TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { Action, RoleRules } from "../../config.ts";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Input } from "../components/ui/input.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { cn } from "../lib/utils.ts";
import { Segmented } from "./segmented.tsx";

/**
 * One role's rules, edited as levels rather than separate actions. Each content type and the media
 * library get a level that includes everything to its left (No access › Read › Write › Publish, or
 * No access › Read › Upload) and a separate Delete, which is never implied. Used by the site's Roles
 * page, where the site's types are known, and by the hub's templates, where type names are typed in.
 */

type Level = "none" | "read" | "write" | "publish";
type MediaLevel = "none" | "read" | "upload";

const LEVELS: Array<{ value: Level, label: string }> = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "publish", label: "Publish" }
];

const MEDIA_LEVELS: Array<{ value: MediaLevel, label: string }> = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read" },
  { value: "upload", label: "Upload" }
];

const BACKUP_LEVELS: Array<{ value: "none" | "take" | "restore", label: string }> = [
  { value: "none", label: "No access" },
  { value: "take", label: "Take" },
  { value: "restore", label: "Take and restore" }
];

const SPECIAL = new Set(["all", "publish", "write", "media", "siteSettings", "backups", "*"]);

function levelOf(actions: Action[] | undefined): Level {
  if(!actions?.length) return "none";
  if(actions.includes("publish")) return "publish";
  if(actions.includes("write")) return "write";
  return "read";
}

function actionsFor(level: Level, remove: boolean): Action[] {
  const actions: Action[] = level === "none" ? [] : level === "read" ? ["read"] : level === "write" ? ["read", "write"] : ["read", "write", "publish"];
  return actions.length && remove ? [...actions, "delete"] : actions;
}

/**
 * Today's terms for what the editor shows: `publish: false` becomes types without `publish`. Without
 * an explicit media rule, the library follows write access, so it's shown as what that gives.
 */
export function editableRules(rules: RoleRules): RoleRules {
  if(rules.publish !== false) return rules;
  const out: RoleRules = {};
  for(const [key, value] of Object.entries(rules)) {
    if(key === "publish") continue;
    out[key] = Array.isArray(value) && key !== "media" ? (value as Action[]).filter(a => a !== "publish") : value;
  }
  return out;
}

export function RoleRulesEditor({ rules, onChange, types, locales, readOnly }: {
  rules: RoleRules,
  onChange(next: RoleRules): void,
  /** The site's content types; null for a template, where types are typed in. */
  types: Array<{ name: string, label: string }> | null,
  /** The site's locales; null for a template. */
  locales: string[] | null,
  readOnly?: boolean
}) {
  const [newType, setNewType] = useState("");

  function set(key: string, value: unknown) {
    const next = { ...rules };
    if(value === undefined || value === false) delete next[key];
    else next[key] = value as RoleRules[string];
    onChange(next);
  }

  const star = rules["*"] as Action[] | undefined;
  const rows = types
    ? types.map(type => ({ key: type.name, label: type.label }))
    : Object.keys(rules).filter(key => !SPECIAL.has(key)).map(key => ({ key, label: key }));
  const anyWrite = Object.entries(rules).some(([key, value]) => key !== "media" && Array.isArray(value) && value.includes("write"));
  const media = rules.media ?? (anyWrite ? ["read", "write"] as Action[] : ["read"] as Action[]);
  const mediaLevel: MediaLevel = !media.length ? "none" : media.includes("write") ? "upload" : "read";
  const writeLocales = rules.write?.locales;

  return (
    // Laid out by the editor's own width, so it fits the site's Roles page and the hub's templates alike.
    <div className="@container flex flex-col">
      <Row title="Everything" description="Every permission, including changing roles and who can sign in: the same as an owner.">
        <Switch checked={rules.all === true} disabled={readOnly} aria-label="Everything" onCheckedChange={on => set("all", on || undefined)} />
      </Row>
      {rules.all && (
        <p className="mx-5 mb-4 flex gap-2 rounded-[10px] bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          People with this role can give themselves and anyone else any access, and remove other people's. Only give it to people you'd make an owner.
        </p>
      )}

      {!rules.all && (
        <>
          <div className="flex flex-col gap-1 border-t px-5 pt-4 pb-1">
            <p className="text-sm font-medium">Content</p>
            <p className="text-sm text-muted-foreground">Each level includes the ones before it: writing needs reading, publishing needs writing. Deleting is separate.</p>
          </div>
          <ul className="divide-y">
            {rows.map(row => {
              const own = rules[row.key] as Action[] | undefined;
              const actions = own ?? star;
              return (
                <AccessRow
                  key={row.key}
                  title={row.label}
                  code={types && row.key !== row.label ? row.key : undefined}
                  hint={!own && star ? "Same as other types" : undefined}
                  levels={LEVELS}
                  level={levelOf(actions)}
                  remove={actions?.includes("delete") ?? false}
                  readOnly={readOnly}
                  onChange={(level, remove) => set(row.key, actionsFor(level, remove))}
                  onRemoveRow={!types ? () => set(row.key, undefined) : undefined}
                />
              );
            })}
            <AccessRow
              title={types ? "Other types" : "Every other type"}
              hint={types ? "Including types added later" : "Types not listed above"}
              levels={LEVELS}
              level={levelOf(star)}
              remove={star?.includes("delete") ?? false}
              readOnly={readOnly}
              onChange={(level, remove) => set("*", level === "none" ? undefined : actionsFor(level, remove))}
            />
          </ul>
          {!types && !readOnly && (
            <div className="flex gap-2 px-5 py-3">
              <Input value={newType} onChange={e => setNewType(e.target.value)} placeholder="post" aria-label="Content type" className="h-8 w-40" />
              <Button size="sm" variant="outline" disabled={!newType.trim() || SPECIAL.has(newType.trim()) || newType.trim() in rules} onClick={() => {
                set(newType.trim(), ["read"]);
                setNewType("");
              }}>Add content type</Button>
            </div>
          )}

          <ul className="border-t">
            <AccessRow
              title="Media library"
              hint="Upload adds files"
              levels={MEDIA_LEVELS}
              level={mediaLevel}
              remove={media.includes("delete")}
              readOnly={readOnly}
              onChange={(level, remove) => set("media", level === "none" ? [] : [...(level === "upload" ? ["read", "write"] : ["read"]) as Action[], ...(remove ? ["delete" as const] : [])])}
            />
          </ul>

          {(locales === null || locales.length > 1) && (
            <Row title="Languages" description="Limit writing to some languages. None chosen: every language." wide>
              {locales ? (
                <div className="flex flex-wrap gap-x-4 gap-y-2 @2xl:justify-end">
                  {locales.map(locale => (
                    <label key={locale} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={writeLocales?.includes(locale) ?? false}
                        disabled={readOnly}
                        onCheckedChange={on => {
                          const next = new Set(writeLocales ?? []);
                          if(on) next.add(locale);
                          else next.delete(locale);
                          set("write", next.size ? { locales: locales.filter(l => next.has(l)) } : undefined);
                        }}
                      />
                      {locale}
                    </label>
                  ))}
                </div>
              ) : (
                <Input className="h-8 w-full @2xl:w-48" placeholder="fr, de" disabled={readOnly} defaultValue={(writeLocales ?? []).join(", ")}
                  onBlur={e => {
                    const next = e.target.value.split(",").map(l => l.trim()).filter(Boolean);
                    set("write", next.length ? { locales: next } : undefined);
                  }} />
              )}
            </Row>
          )}

          <Row title="Site settings" description="Name, accent color and icon.">
            <Switch checked={rules.siteSettings === true} disabled={readOnly} aria-label="Site settings" onCheckedChange={on => set("siteSettings", on || undefined)} />
          </Row>

          <ul className="border-t">
            <AccessRow
              title="Backups"
              hint="A restore replaces everything"
              levels={BACKUP_LEVELS}
              level={rules.backups === true ? "restore" : rules.backups === "take" ? "take" : "none"}
              readOnly={readOnly}
              onChange={value => set("backups", value === "restore" ? true : value === "take" ? "take" : undefined)}
            />
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * A level picker and, for content and media, a Delete checkbox. Narrow: the name with Delete beside
 * it, the levels full width underneath. Wide: name, levels and Delete in columns that line up from
 * row to row, so every picker on the page has the same width.
 */
function AccessRow<L extends string>({ title, code, hint, levels, level, remove, readOnly, onChange, onRemoveRow }: {
  title: string,
  code?: string,
  hint?: string,
  levels: Array<{ value: L, label: string }>,
  level: L,
  /** Whether Delete is ticked; leave out for rows without one. */
  remove?: boolean,
  readOnly?: boolean,
  onChange(level: L, remove: boolean): void,
  onRemoveRow?(): void
}) {
  const none = level === levels[0]!.value;
  return (
    <li className="grid list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-5 py-3 @2xl:grid-cols-[minmax(0,1fr)_19rem_auto]">
      <div className="min-w-0">
        <p className="text-sm font-medium break-words">{title}</p>
        {code && <code className="block font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">{wordBreaks(code)}</code>}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="col-span-2 @2xl:col-span-1 @2xl:col-start-2 @2xl:row-start-1">
        <Segmented fill label={`${title} access`} options={levels} value={level} disabled={readOnly} onChange={next => onChange(next, next === levels[0]!.value ? false : remove ?? false)} />
      </div>
      <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 @2xl:col-start-3">
        {remove !== undefined ? (
          <label className={cn("flex items-center gap-2 text-sm whitespace-nowrap", none && "opacity-40")}>
            <Checkbox checked={remove && !none} disabled={readOnly || none} onCheckedChange={on => onChange(level, on)} />
            Delete
          </label>
        ) : (
          // Takes Delete's width on wide rows, so this row's levels line up with the others.
          <span aria-hidden className="invisible hidden items-center gap-2 text-sm @2xl:flex"><span className="size-4" />Delete</span>
        )}
        {onRemoveRow && !readOnly && <Button variant="ghost" size="icon-xs" aria-label={`Remove ${title}`} onClick={onRemoveRow}><XIcon /></Button>}
      </div>
    </li>
  );
}

/** An ID that may wrap between its words (`locationTemplate` → location·Template), not mid-word. */
function wordBreaks(id: string): React.ReactNode {
  return id.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[_-])/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));
}

/** A setting with its control at the right. `wide` controls go under the name when the editor is narrow. */
function Row({ title, description, wide, children }: { title: string, description: string, wide?: boolean, children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 border-t px-5 py-4 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className={cn("flex justify-end", wide && "col-span-2 justify-start @2xl:col-span-1")}>{children}</div>
    </div>
  );
}
