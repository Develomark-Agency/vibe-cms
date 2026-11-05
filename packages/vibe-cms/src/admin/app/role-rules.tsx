import { XIcon } from "lucide-react";
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
    <div className="flex flex-col">
      <Row title="Everything" description="Every permission, including roles and who may sign in.">
        <Switch checked={rules.all === true} disabled={readOnly} onCheckedChange={on => set("all", on || undefined)} />
      </Row>

      {!rules.all && (
        <>
          <div className="flex flex-col gap-1 px-5 pt-4 pb-1">
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
                  code={types ? row.key : undefined}
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
              hint={types ? "Types without their own level, and types added later" : "Types the site has that aren't listed above"}
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

          <div className="mt-2 border-t">
            <AccessRow
              title="Media library"
              hint="Uploading is writing to the library"
              levels={MEDIA_LEVELS}
              level={mediaLevel}
              remove={media.includes("delete")}
              readOnly={readOnly}
              onChange={(level, remove) => set("media", level === "none" ? [] : [...(level === "upload" ? ["read", "write"] : ["read"]) as Action[], ...(remove ? ["delete" as const] : [])])}
            />
          </div>

          {(locales === null || locales.length > 1) && (
            <Row title="Languages" description="Limit writing to some languages. None chosen: every language.">
              {locales ? (
                <div className="flex flex-wrap justify-end gap-x-4 gap-y-2">
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
                <Input className="h-8 w-48" placeholder="fr, de" disabled={readOnly} defaultValue={(writeLocales ?? []).join(", ")}
                  onBlur={e => {
                    const next = e.target.value.split(",").map(l => l.trim()).filter(Boolean);
                    set("write", next.length ? { locales: next } : undefined);
                  }} />
              )}
            </Row>
          )}

          <Row title="Site settings" description="Name, accent color and icon.">
            <Switch checked={rules.siteSettings === true} disabled={readOnly} onCheckedChange={on => set("siteSettings", on || undefined)} />
          </Row>

          <Row title="Backups" description="Taking a snapshot reads everything. Restoring one replaces everything.">
            <Segmented
              label="Backups"
              className="shrink-0 flex-nowrap"
              options={BACKUP_LEVELS}
              value={rules.backups === true ? "restore" : rules.backups === "take" ? "take" : "none"}
              disabled={readOnly}
              onChange={value => set("backups", value === "restore" ? true : value === "take" ? "take" : undefined)}
            />
          </Row>
        </>
      )}
    </div>
  );
}

function AccessRow<L extends string>({ title, code, hint, levels, level, remove, readOnly, onChange, onRemoveRow }: {
  title: string,
  code?: string,
  hint?: string,
  levels: Array<{ value: L, label: string }>,
  level: L,
  remove: boolean,
  readOnly?: boolean,
  onChange(level: L, remove: boolean): void,
  onRemoveRow?(): void
}) {
  const none = level === "none";
  return (
    <li className="flex list-none flex-col gap-3 px-5 py-3 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm">
          <span className="font-medium">{title}</span>
          {code && <code className="ml-2 font-mono text-xs text-muted-foreground">{code}</code>}
        </p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <Segmented label={`${title} access`} className="flex-nowrap" options={levels} value={level} disabled={readOnly} onChange={next => onChange(next, next === levels[0]!.value ? false : remove)} />
        <label className={cn("flex items-center gap-2 text-sm", none && "opacity-40")}>
          <Checkbox checked={remove && !none} disabled={readOnly || none} onCheckedChange={on => onChange(level, on)} />
          Delete
        </label>
        {onRemoveRow && !readOnly && <Button variant="ghost" size="icon-xs" aria-label={`Remove ${title}`} onClick={onRemoveRow}><XIcon /></Button>}
      </div>
    </li>
  );
}

function Row({ title, description, children }: { title: string, description: string, children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t px-5 py-4 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
