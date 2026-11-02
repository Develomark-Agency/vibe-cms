import { ChevronDownIcon, ChevronUpIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, CopyIcon, GripVerticalIcon, LocateFixedIcon, PlusIcon, Trash2Icon, XIcon, CalendarIcon } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { IMPL, loadLazy, type WidgetDescriptor } from "../../descriptor.ts";
import type {
  AnySchema,
  ArraySchema,
  DateSchema,
  EnumSchema,
  LiteralSchema,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  TextSchema,
  UnionSchema,
  DocumentData,
  JsonValue
} from "../../schema/types.ts";
import { emptyValue, matchesDiscriminators, type Issue, type Path } from "../../schema/validate.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Calendar } from "../components/ui/calendar.tsx";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../components/ui/command.tsx";
import { Input } from "../components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { cn } from "../lib/utils.ts";
import type { FieldDescriptor, WidgetContext, WidgetImpl } from "../index.ts";
import { humanize, useAdmin } from "./context.tsx";
import { setDragChip } from "./drag-chip.ts";
import { navIcons } from "./icons.ts";
import { focusPreviewBlock, getPreview, subscribePreview } from "./preview.ts";
import { AssetControl, RefControl } from "./pickers.tsx";
import { Segmented } from "./segmented.tsx";

export interface FieldProps {
  schema: AnySchema,
  value: JsonValue | undefined,
  onChange(value: JsonValue | undefined): void,
  path: Path,
  name: string,
  issues: Issue[],
  readOnly: boolean,
  doc: { type: string, id: string | null },
  label?: string,
  /** Rendered inline (array items, union variants) without the label row. */
  bare?: boolean
}

function samePath(a: Path, b: Path) {
  return a.length === b.length && a.every((s, i) => String(s) === String(b[i]));
}

function startsWith(path: Path, prefix: Path) {
  return prefix.every((s, i) => String(s) === String(path[i]));
}

export function issuesUnder(issues: Issue[], path: Path): Issue[] {
  return issues.filter(issue => startsWith(issue.path, path));
}

function unwrap(schema: AnySchema): AnySchema {
  return schema.type === "optional" ? (schema as OptionalSchema).inner : schema;
}

/** Renders any field: a custom widget if the schema names one, otherwise the built-in control for its type. */
export function Field(props: FieldProps) {
  const { schema, path, issues, name } = props;
  const { locale, plugins, cms } = useAdmin();
  const inner = unwrap(schema);
  if(inner.type === "literal" || schema.hidden || inner.hidden) return null;
  // Derived fields (`readOnly`) are shown but never edited.
  const derived = Boolean(schema.readOnly || inner.readOnly);
  props = { ...props, readOnly: props.readOnly || derived };
  const errors = issues.filter(issue => samePath(issue.path, path)).map(issue => issue.message);
  const label = props.label ?? schema.label ?? inner.label ?? humanize(name);
  const descriptor: FieldDescriptor = {
    name,
    path,
    label,
    description: schema.description ?? inner.description,
    schema,
    errors,
    issues: issuesUnder(issues, path),
    required: schema.type !== "optional",
    readOnly: props.readOnly,
    locale,
    document: props.doc
  };
  const widget = schema.widget ?? inner.widget;
  let control: ReactNode = widget
    ? <WidgetHost descriptor={widget} field={descriptor} value={props.value} onChange={props.onChange} />
    : <BuiltinControl {...props} schema={inner} optional={schema.type === "optional"} field={descriptor} />;

  for(const decorator of plugins.fieldDecorators) {
    if(decorator.match && !decorator.match(descriptor)) continue;
    const Decorator = decorator.component;
    control = <Decorator field={descriptor} value={props.value} onChange={props.onChange} cms={cms}>{control}</Decorator>;
  }

  const grouped = inner.type === "object" || (inner.type === "array" && !isTagList(inner)) || inner.type === "union";
  if(props.bare) {
    return <div className="flex flex-col gap-2">{control}<Errors errors={errors} /></div>;
  }
  return (
    <div className="group/field flex flex-col gap-2" data-field={path.join(".")} data-invalid={errors.length > 0 || undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <label className={cn("text-sm font-medium leading-none", errors.length && "text-destructive")} htmlFor={fieldId(path)}>
          {label}
          {derived ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">Set automatically</span>
            : schema.type === "optional" ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">Optional</span> : null}
        </label>
        {grouped && !widget && Array.isArray(props.value) ? <span className="text-xs text-muted-foreground">{props.value.length} items</span> : null}
      </div>
      {descriptor.description ? <p className="-mt-1 text-xs text-muted-foreground">{descriptor.description}</p> : null}
      {control}
      <Errors errors={errors} />
    </div>
  );
}

function Errors({ errors }: { errors: string[] }) {
  if(!errors.length) return null;
  return <p className="text-xs text-destructive" role="alert">{errors.join(". ")}</p>;
}

export function fieldId(path: Path) {
  return `field-${path.join("-")}`;
}

// --- Widgets -----------------------------------------------------------------

const widgetCache = new Map<string, Promise<WidgetImpl>>();

function loadWidget(descriptor: WidgetDescriptor): Promise<WidgetImpl> {
  let promise = widgetCache.get(descriptor.id);
  if(!promise) {
    promise = loadLazy(descriptor[IMPL].admin) as Promise<WidgetImpl>;
    widgetCache.set(descriptor.id, promise);
  }
  return promise;
}

function WidgetHost({ descriptor, field, value, onChange }: {
  descriptor: WidgetDescriptor,
  field: FieldDescriptor,
  value: JsonValue | undefined,
  onChange(value: JsonValue | undefined): void
}) {
  const { cms } = useAdmin();
  const [impl, setImpl] = useState<WidgetImpl | Error | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadWidget(descriptor).then(
      loaded => !cancelled && setImpl(loaded),
      error => !cancelled && setImpl(error instanceof Error ? error : new Error(String(error)))
    );
    return () => {
      cancelled = true;
    };
  }, [descriptor]);
  const ctx: WidgetContext = { value, onChange, options: descriptor.options, field, cms };
  if(impl instanceof Error) {
    return <div className="rounded-[10px] bg-destructive/8 p-3 text-sm text-destructive shadow-[inset_0_0_0_1px] shadow-destructive/25">Widget “{descriptor.id}” failed to load: {impl.message}</div>;
  }
  if(!impl) return <div className="h-9 animate-pulse rounded-[10px] well" />;
  if(impl.react) {
    const Component = impl.react;
    return <Component {...ctx} />;
  }
  return <MountedWidget impl={impl} ctx={ctx} />;
}

/** Hosts a framework-neutral widget through its `mount` contract. */
function MountedWidget({ impl, ctx }: { impl: WidgetImpl, ctx: WidgetContext }) {
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef<ReturnType<WidgetImpl["mount"]> | null>(null);
  useEffect(() => {
    mounted.current = impl.mount(ref.current!, ctx);
    return () => {
      mounted.current?.unmount();
      mounted.current = null;
    };
    // Mount once per implementation; updates flow through `update`.
  }, [impl]);
  useEffect(() => {
    mounted.current?.update(ctx);
  });
  return <div ref={ref} />;
}

// --- Built-in controls ---------------------------------------------------------

type ControlProps = FieldProps & { optional: boolean, field: FieldDescriptor };

function BuiltinControl(props: ControlProps) {
  switch(props.schema.type) {
    case "text": return <TextControl {...props} />;
    case "number": return <NumberControl {...props} />;
    case "boolean": return <BooleanControl {...props} />;
    case "date": return <DateControl {...props} />;
    case "enum": return <EnumControl {...props} />;
    case "object": return <ObjectControl {...props} />;
    case "array": return isTagList(props.schema) ? <TagControl {...props} /> : <ArrayControl {...props} />;
    case "union": return <UnionControl {...props} />;
    case "ref": return <RefControl {...props} />;
    case "asset": return <AssetControl {...props} options={{ focal: false }} />;
    default:
      return <p className="text-sm text-muted-foreground">No editor for “{props.schema.type}” fields.</p>;
  }
}

function TextControl({ schema, value, onChange, path, readOnly, optional, field }: ControlProps) {
  const s = schema as TextSchema;
  const text = typeof value === "string" ? value : "";
  const multiline = s.multiline || (s.max ?? 0) > 200;
  function change(next: string) {
    onChange(optional && next === "" ? undefined : next);
  }
  const counter = s.max ? (
    <span className={cn("pointer-events-none absolute right-2.5 bottom-2 text-[11px] tabular-nums text-muted-foreground", text.length > s.max && "text-destructive")}>
      {text.length}/{s.max}
    </span>
  ) : null;
  if(multiline) {
    return (
      <div className="relative">
        <Textarea id={fieldId(path)} value={text} readOnly={readOnly} aria-invalid={field.errors.length > 0} onChange={e => change(e.target.value)} className="min-h-24 pb-6" />
        {counter}
      </div>
    );
  }
  return (
    <div className="relative">
      <Input
        id={fieldId(path)}
        value={text}
        readOnly={readOnly}
        aria-invalid={field.errors.length > 0}
        type={s.format === "email" ? "email" : s.format === "url" ? "url" : "text"}
        onChange={e => change(e.target.value)}
        className={cn(s.max && "pr-16", s.format === "slug" && "font-mono text-[13px]")}
      />
      {counter && <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[11px] tabular-nums text-muted-foreground">{text.length}/{s.max}</span>}
      {s.format === "slug" && !readOnly ? <SlugHelper path={path} current={text} onChange={change} /> : null}
    </div>
  );
}

/** Offers to derive a slug from the document's title. */
function SlugHelper({ path, current, onChange }: { path: Path, current: string, onChange(value: string): void }) {
  const form = useFormValue();
  const title = typeof form?.title === "string" ? form.title : typeof form?.name === "string" ? form.name : "";
  const slug = slugify(title);
  if(path.length !== 1 || !slug || slug === current) return null;
  return (
    <button type="button" className="mt-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onChange(slug)}>
      Generate from title: <span className="font-mono">{slug}</span>
    </button>
  );
}

export function slugify(input: string): string {
  return input.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export const FormValueContext = createContext<DocumentData | null>(null);

function useFormValue() {
  return useContext(FormValueContext);
}

function NumberControl({ schema, value, onChange, path, readOnly, optional, field }: ControlProps) {
  const s = schema as NumberSchema;
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    if(Number(text) !== value) setText(value === undefined || value === null ? "" : String(value));
    // Only resync when the value changes from outside.
  }, [value]);
  return (
    <Input
      id={fieldId(path)}
      inputMode="decimal"
      type="number"
      min={s.min}
      max={s.max}
      step={s.step ?? (s.integer ? 1 : "any")}
      value={text}
      readOnly={readOnly}
      aria-invalid={field.errors.length > 0}
      className="max-w-48 tabular-nums"
      onChange={e => {
        setText(e.target.value);
        if(e.target.value === "") onChange(optional ? undefined : 0);
        else if(!Number.isNaN(e.target.valueAsNumber)) onChange(e.target.valueAsNumber);
      }}
    />
  );
}

function BooleanControl({ value, onChange, path, readOnly }: ControlProps) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={fieldId(path)} checked={value === true} disabled={readOnly} onCheckedChange={checked => onChange(checked)} />
      <span className="text-sm text-muted-foreground">{value === true ? "On" : "Off"}</span>
    </div>
  );
}

function DateControl({ schema, value, onChange, path, readOnly, optional, field }: ControlProps) {
  const s = schema as DateSchema;
  const [open, setOpen] = useState(false);
  const date = typeof value === "string" && value ? new Date(s.time ? value : `${value}T00:00:00`) : undefined;
  const valid = date && !Number.isNaN(date.getTime()) ? date : undefined;
  function set(next: Date | undefined, time?: string) {
    if(!next) return onChange(optional ? undefined : value);
    if(!s.time) {
      const y = next.getFullYear();
      const m = String(next.getMonth() + 1).padStart(2, "0");
      const d = String(next.getDate()).padStart(2, "0");
      return onChange(`${y}-${m}-${d}`);
    }
    const [hh, mm] = (time ?? (valid ? `${valid.getHours()}:${valid.getMinutes()}` : "09:00")).split(":").map(Number);
    const out = new Date(next);
    out.setHours(hh ?? 0, mm ?? 0, 0, 0);
    onChange(out.toISOString());
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button id={fieldId(path)} variant="outline" disabled={readOnly} aria-invalid={field.errors.length > 0} className={cn("w-56 justify-start font-normal", !valid && "text-muted-foreground")}>
              <CalendarIcon />
              {valid ? valid.toLocaleDateString(undefined, { dateStyle: "medium" }) : "Pick a date"}
            </Button>
          }
        />
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={valid}
            defaultMonth={valid}
            captionLayout="dropdown"
            onSelect={next => {
              set(next);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {s.time && (
        <Input
          type="time"
          className="w-32"
          disabled={readOnly || !valid}
          value={valid ? `${String(valid.getHours()).padStart(2, "0")}:${String(valid.getMinutes()).padStart(2, "0")}` : ""}
          onChange={e => valid && set(valid, e.target.value)}
        />
      )}
      {valid && optional && !readOnly ? (
        <Button variant="ghost" size="icon-sm" aria-label="Clear date" onClick={() => onChange(undefined)}><XIcon /></Button>
      ) : null}
    </div>
  );
}

function EnumControl({ schema, value, onChange, path, readOnly, optional, field }: ControlProps) {
  const s = schema as EnumSchema;
  const items = s.values.map(v => ({ value: v, label: s.labels?.[v] ?? humanize(v) }));
  if(s.values.length <= 4 && !optional) {
    return (
      <Segmented
        id={fieldId(path)}
        label={field.label}
        options={items}
        value={typeof value === "string" ? value : undefined}
        onChange={onChange}
        disabled={readOnly}
      />
    );
  }
  return (
    <Select
      items={[...(optional ? [{ value: "", label: "None" }] : []), ...items]}
      value={typeof value === "string" ? value : ""}
      onValueChange={next => onChange(next === "" ? undefined : next)}
      disabled={readOnly}
    >
      <SelectTrigger id={fieldId(path)} className="w-64" aria-invalid={field.errors.length > 0}>
        <SelectValue placeholder="Choose…" />
      </SelectTrigger>
      <SelectContent>
        {optional && <SelectItem value="">None</SelectItem>}
        {items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** `v.array(v.text())` edits as tags. */
function isTagList(schema: AnySchema): boolean {
  if(schema.type !== "array") return false;
  const item = unwrap((schema as ArraySchema).item);
  return item.type === "text" && !(item as TextSchema).multiline && !item.widget;
}

function TagControl({ value, onChange, path, readOnly }: ControlProps) {
  const tags = Array.isArray(value) ? (value as string[]) : [];
  const [draft, setDraft] = useState("");
  function add(text: string) {
    const parts = text.split(",").map(t => t.trim()).filter(t => t && !tags.includes(t));
    if(parts.length) onChange([...tags, ...parts]);
    setDraft("");
  }
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-[10px] well p-1 focus-within:ring-3 focus-within:ring-ring/50">
      {tags.map(tag => (
        <Badge key={tag} variant="secondary" className="h-6 gap-1 rounded-[6px] border-0 pr-1 raised text-foreground">
          {tag}
          {!readOnly && (
            <button type="button" aria-label={`Remove ${tag}`} className="rounded-sm opacity-60 hover:opacity-100" onClick={() => onChange(tags.filter(t => t !== tag))}>
              <XIcon className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      {!readOnly && (
        <input
          id={fieldId(path)}
          value={draft}
          placeholder={tags.length ? "" : "Type and press Enter"}
          className="min-w-24 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground"
          onChange={e => (e.target.value.includes(",") ? add(e.target.value) : setDraft(e.target.value))}
          onBlur={() => draft && add(draft)}
          onKeyDown={e => {
            if(e.key === "Enter") {
              e.preventDefault();
              add(draft);
            } else if(e.key === "Backspace" && !draft && tags.length) {
              onChange(tags.slice(0, -1));
            }
          }}
        />
      )}
    </div>
  );
}

function ObjectControl({ schema, value, onChange, path, issues, readOnly, optional, doc, bare }: ControlProps) {
  const s = schema as ObjectSchema;
  const obj = (value && typeof value === "object" ? value : undefined) as DocumentData | undefined;
  if(!obj) {
    if(readOnly) return <p className="text-sm text-muted-foreground">Not set</p>;
    return (
      <Button variant="outline" size="sm" className="w-fit" onClick={() => onChange(emptyValue(s))}>
        <PlusIcon /> Add
      </Button>
    );
  }
  const fields = Object.entries(s.shape).filter(([, f]) => unwrap(f).type !== "literal");
  return (
    <div className={cn("flex flex-col gap-5", !bare && "rounded-[16px] elevated p-4")}>
      {fields.map(([key, field]) => (
        <Field
          key={key}
          schema={field}
          name={key}
          path={[...path, key]}
          value={obj[key]}
          issues={issues}
          readOnly={readOnly}
          doc={doc}
          onChange={next => {
            const copy = { ...obj };
            if(next === undefined) delete copy[key];
            else copy[key] = next;
            onChange(copy);
          }}
        />
      ))}
      {optional && !readOnly && (
        <Button variant="ghost" size="sm" className="w-fit text-muted-foreground" onClick={() => onChange(undefined)}>
          <Trash2Icon /> Remove
        </Button>
      )}
    </div>
  );
}

/** Union variants are named by their literal discriminator (e.g. `kind: "heading"`). */
export function variantLabel(option: AnySchema, index: number): string {
  if(option.label) return option.label;
  if(option.type === "object") {
    const literal = Object.values((option as ObjectSchema).shape).find(f => f.type === "literal") as LiteralSchema | undefined;
    if(literal && typeof literal.value === "string") return humanize(literal.value);
  }
  return option.type === "object" ? `Option ${index + 1}` : humanize(option.type);
}

function variantIndex(schema: UnionSchema, value: unknown): number {
  const found = schema.options.findIndex(option => matchesDiscriminators(option, value));
  return found;
}

function UnionControl({ schema, value, onChange, path, issues, readOnly, doc, name }: ControlProps) {
  const s = schema as UnionSchema;
  const index = variantIndex(s, value);
  const option = index >= 0 ? s.options[index]! : undefined;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Type</span>
        <Select
          items={s.options.map((o, i) => ({ value: String(i), label: variantLabel(o, i) }))}
          value={index >= 0 ? String(index) : ""}
          disabled={readOnly}
          onValueChange={next => onChange(emptyValue(s.options[Number(next)]!))}
        >
          <SelectTrigger size="sm" className="w-48"><SelectValue placeholder="Choose…" /></SelectTrigger>
          <SelectContent>
            {s.options.map((o, i) => <SelectItem key={i} value={String(i)}>{variantLabel(o, i)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {option && (
        <Field bare schema={option} name={name} path={path} value={value} onChange={onChange} issues={issues} readOnly={readOnly} doc={doc} />
      )}
    </div>
  );
}

function moveItem(items: JsonValue[], from: number, to: number): JsonValue[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Stable React keys for array items across add / remove / move. */
function useItemKeys(length: number) {
  const keys = useRef<string[]>([]);
  const counter = useRef(0);
  while(keys.current.length < length) keys.current.push(`k${counter.current++}`);
  if(keys.current.length > length) keys.current.length = length;
  return {
    keys: keys.current,
    insert(at: number) {
      keys.current.splice(at, 0, `k${counter.current++}`);
    },
    remove(at: number) {
      keys.current.splice(at, 1);
    },
    move(from: number, to: number) {
      const [key] = keys.current.splice(from, 1);
      keys.current.splice(to, 0, key!);
    }
  };
}

function itemSummary(schema: AnySchema, value: unknown, index: number): string {
  const inner = unwrap(schema);
  if(inner.type === "union") {
    const option = (inner as UnionSchema).options[variantIndex(inner as UnionSchema, value)];
    return option ? variantLabel(option, index) : `Item ${index + 1}`;
  }
  if(inner.type === "object" && value && typeof value === "object") {
    const text = Object.entries((inner as ObjectSchema).shape)
      .map(([key, field]) => (unwrap(field).type === "text" ? (value as DocumentData)[key] : undefined))
      .find(v => typeof v === "string" && v.trim());
    if(typeof text === "string") return text;
  }
  if(inner.type === "ref" || inner.type === "asset") return `Item ${index + 1}`;
  if(typeof value === "string" || typeof value === "number") return String(value) || `Item ${index + 1}`;
  return `Item ${index + 1}`;
}

function ArrayControl({ schema, value, onChange, path, issues, readOnly, doc }: ControlProps) {
  const s = schema as ArraySchema;
  const items = Array.isArray(value) ? value : [];
  const { keys, insert, remove, move } = useItemKeys(items.length);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const item = unwrap(s.item);
  const variants = item.type === "union" ? (item as UnionSchema).options : null;
  const atMax = s.max !== undefined && items.length >= s.max;
  const simple = ["ref", "asset", "text", "number", "date", "enum"].includes(item.type);
  // A document's top-level blocks are what the site's <Blocks> renders, in this order.
  const previewing = useSyncExternalStore(subscribePreview, () => getPreview().ready) && variants !== null && path.length === 1;

  function add(next: JsonValue | undefined) {
    insert(items.length);
    onChange([...items, next ?? null]);
  }

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  function insertAt(at: number, next: JsonValue | undefined) {
    insert(at);
    onChange([...items.slice(0, at), next ?? null, ...items.slice(at)]);
  }

  /** Where a drop lands, as an insertion index; null when it wouldn't move anything. */
  function dropTarget(): number | null {
    if(dragFrom === null || dropAt === null || dropAt === dragFrom || dropAt === dragFrom + 1) return null;
    return dropAt;
  }

  function drop() {
    const target = dropTarget();
    if(dragFrom !== null && target !== null) {
      const to = target > dragFrom ? target - 1 : target;
      move(dragFrom, to);
      onChange(moveItem(items, dragFrom, to));
    }
    setDragFrom(null);
    setDropAt(null);
  }

  const addLabel = variants ? (s.item.label ?? "block").toLowerCase() : s.item.label?.toLowerCase() ?? "item";
  const addButton = readOnly || atMax ? null : variants ? (
    <VariantPicker
      variants={variants}
      onPick={index => add(emptyValue(variants[index]!))}
      trigger={<Button variant="outline" size="sm" className="w-fit"><PlusIcon /> Add {addLabel === "item" ? "block" : addLabel}</Button>}
    />
  ) : (
    <Button variant="outline" size="sm" className="w-fit" onClick={() => add(emptyValue(item))}>
      <PlusIcon /> Add {s.item.label?.toLowerCase() ?? "item"}
    </Button>
  );

  const cards = !simple;
  return (
    <div className="flex flex-col gap-2">
      {variants && items.length > 1 && (
        <div className="-mt-1 flex justify-end">
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setCollapsed(collapsed.size === items.length ? new Set() : new Set(keys))}>
            {collapsed.size === items.length ? <><ChevronsUpDownIcon /> Expand all</> : <><ChevronsDownUpIcon /> Collapse all</>}
          </Button>
        </div>
      )}
      {items.length === 0 && <p className="rounded-[14px] well px-3 py-4 text-center text-sm text-muted-foreground">{variants ? "No blocks yet" : "No items yet"}</p>}
      {items.map((entry, i) => {
        const key = keys[i]!;
        const itemPath = [...path, i];
        const hasIssues = issuesUnder(issues, itemPath).length > 0;
        const isCollapsed = collapsed.has(key);
        const controls = !readOnly && (
          <div className="flex shrink-0 items-center opacity-60 transition-opacity group-hover/item:opacity-100">
            <Button variant="ghost" size="icon-xs" aria-label="Move up" disabled={i === 0} onClick={() => {
              move(i, i - 1);
              onChange(moveItem(items, i, i - 1));
            }}><ChevronUpIcon /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="Move down" disabled={i === items.length - 1} onClick={() => {
              move(i, i + 1);
              onChange(moveItem(items, i, i + 1));
            }}><ChevronDownIcon /></Button>
            {!simple && (
              <Button variant="ghost" size="icon-xs" aria-label="Duplicate" disabled={atMax} onClick={() => {
                insert(i + 1);
                onChange([...items.slice(0, i + 1), structuredClone(entry), ...items.slice(i + 1)]);
              }}><CopyIcon /></Button>
            )}
            <Button variant="ghost" size="icon-xs" aria-label="Remove" onClick={() => {
              remove(i);
              onChange(items.filter((_, j) => j !== i));
            }}><Trash2Icon /></Button>
          </div>
        );
        if(simple) {
          return (
            <div key={key} className="group/item flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <Field bare schema={s.item} name={String(i)} path={itemPath} value={entry} issues={issues} readOnly={readOnly} doc={doc}
                  onChange={next => onChange(items.map((v, j) => (j === i ? next ?? null : v)))} />
              </div>
              {controls}
            </div>
          );
        }
        const variant = variants ? variants[variantIndex(item as UnionSchema, entry)] : undefined;
        const VariantIcon = variant?.icon ? navIcons[variant.icon] : null;
        const title = variant ? variantLabel(variant, i) : itemSummary(s.item, entry, i);
        const detail = variant ? summarize(variant, entry) : undefined;
        const target = dropTarget();
        return (
          <div key={key} className="relative flex flex-col">
            {!readOnly && cards && i > 0 && (
              <InsertPoint
                variants={variants}
                disabled={atMax}
                onInsert={next => insertAt(i, next)}
                fallback={() => emptyValue(item)}
              />
            )}
            {target === i && <DropLine />}
            <div
              className={cn(
                "group/item overflow-hidden rounded-[14px] elevated transition-opacity",
                hasIssues && "shadow-[0_0_0_1px_var(--destructive),var(--shadow-card)]",
                dragFrom === i && "opacity-40"
              )}
              onDragOver={event => {
                if(dragFrom === null) return;
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setDropAt(event.clientY < rect.top + rect.height / 2 ? i : i + 1);
              }}
              onDrop={event => {
                if(dragFrom === null) return;
                event.preventDefault();
                event.stopPropagation();
                drop();
              }}
            >
              <div className="flex items-center gap-1.5 border-b py-1.5 pr-2 pl-1 data-[collapsed=true]:border-b-0" data-collapsed={isCollapsed}>
                <button
                  type="button"
                  aria-label={`Drag to reorder ${title}`}
                  disabled={readOnly}
                  draggable={!readOnly}
                  onDragStart={event => {
                    setDragFrom(i);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/x-vibe-item", String(i));
                    setDragChip(event, detail ? `${title}: ${detail}` : title);
                  }}
                  onDragEnd={() => {
                    setDragFrom(null);
                    setDropAt(null);
                  }}
                  className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-[6px] text-muted-foreground/50 hover:bg-foreground/[0.05] hover:text-muted-foreground active:cursor-grabbing disabled:cursor-default"
                >
                  <GripVerticalIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                  onClick={() => setCollapsed(prev => {
                    const next = new Set(prev);
                    if(next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })}
                >
                  {VariantIcon && <VariantIcon className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="shrink-0 font-medium">{title}</span>
                  {detail && <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
                  {hasIssues && <span className="size-1.5 shrink-0 rounded-full bg-destructive" />}
                </button>
                {previewing && (
                  <Button variant="ghost" size="icon-xs" aria-label="Show in preview" title="Show in preview (as last saved)" onClick={() => focusPreviewBlock(i)}>
                    <LocateFixedIcon />
                  </Button>
                )}
                {controls}
              </div>
              {!isCollapsed && (
                <div className="p-4">
                  <Field
                    bare
                    schema={variant ?? s.item}
                    name={String(i)}
                    path={itemPath}
                    value={entry}
                    issues={issues}
                    readOnly={readOnly}
                    doc={doc}
                    onChange={next => onChange(items.map((v, j) => (j === i ? next ?? null : v)))}
                  />
                </div>
              )}
            </div>
            {i === items.length - 1 && target === items.length && <DropLine />}
          </div>
        );
      })}
      {addButton}
    </div>
  );
}

/**
 * A block's collapsed summary: the first text it has (a heading, a quote, the
 * start of rich text), found through its schema so settings like a column
 * count don't show up; else how many items its first list holds ("6 images").
 */
function summarize(schema: AnySchema, value: unknown, depth = 0): string | undefined {
  const inner = unwrap(schema);
  // Rich text nests ~8 deep (block → body → node → children → text).
  if(depth > 10 || value === null || value === undefined) return undefined;
  if(inner.type === "text") return typeof value === "string" && value.trim() && !/^(https?:|\/|#)/.test(value) ? value.trim().slice(0, 120) : undefined;
  if(inner.type === "union") {
    const option = (inner as UnionSchema).options.find(o => matchesDiscriminators(o, value));
    return option ? summarize(option, value, depth + 1) : undefined;
  }
  if(inner.type === "array" && Array.isArray(value)) {
    for(const entry of value) {
      const found = summarize((inner as ArraySchema).item, entry, depth + 1);
      if(found) return found;
    }
    return undefined;
  }
  if(inner.type === "object" && typeof value === "object") {
    const shape = (inner as ObjectSchema).shape;
    for(const [key, field] of Object.entries(shape)) {
      const found = summarize(field, (value as DocumentData)[key], depth + 1);
      if(found) return found;
    }
    if(depth === 0) {
      for(const [key, field] of Object.entries(shape)) {
        const list = (value as DocumentData)[key];
        if(unwrap(field).type === "array" && Array.isArray(list) && list.length > 0) {
          return `${list.length} ${(field.label ?? humanize(key)).toLowerCase()}`;
        }
      }
    }
  }
  return undefined;
}

function DropLine() {
  return <div aria-hidden className="pointer-events-none absolute inset-x-2 -top-[5px] z-10 h-0.5 rounded-full bg-foreground/60 last:top-auto last:-bottom-[5px]" />;
}

/**
 * A searchable menu of a union's variants with their icons and descriptions:
 * how editors pick a block. Radii nest: 4px of menu padding around 10px rows,
 * 4px of row padding around 6px icon tiles.
 */
function VariantPicker({ variants, onPick, trigger }: { variants: readonly AnySchema[], onPick(index: number): void, trigger: React.ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-[22rem] p-0">
        <Command>
          {variants.length > 6 && <CommandInput placeholder="Find a block…" />}
          <CommandList className="max-h-80">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {variants.map((variant, i) => {
              const Icon = variant.icon ? navIcons[variant.icon] : PlusIcon;
              return (
                <CommandItem
                  key={i}
                  value={`${variantLabel(variant, i)} ${variant.description ?? ""}`}
                  onSelect={() => {
                    setOpen(false);
                    onPick(i);
                  }}
                  className="gap-3 p-1 pr-2"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-[6px] raised"><Icon className="size-4" /></span>
                  <span className="min-w-0">
                    <span className="block font-medium">{variantLabel(variant, i)}</span>
                    {variant.description && <span className="line-clamp-2 block text-xs text-muted-foreground">{variant.description}</span>}
                  </span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** A "+" that appears between items on hover, to insert right there. */
function InsertPoint({ variants, disabled, onInsert, fallback }: {
  variants: readonly AnySchema[] | null,
  disabled: boolean,
  onInsert(value: JsonValue | undefined): void,
  fallback(): JsonValue | undefined
}) {
  if(disabled) return null;
  const button = (
    <button
      type="button"
      aria-label="Insert here"
      onClick={variants ? undefined : () => onInsert(fallback())}
      className="flex size-5 items-center justify-center rounded-full raised text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/insert:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
    >
      <PlusIcon className="size-3" />
    </button>
  );
  return (
    // Sits in the 8px gap between cards, overlapping it so it doesn't push them apart.
    <div className="group/insert absolute inset-x-0 -top-[13px] z-10 flex h-[18px] items-center justify-center">
      <div aria-hidden className="absolute inset-x-6 h-px bg-foreground/15 opacity-0 transition-opacity group-hover/insert:opacity-100" />
      <span className="relative">{variants ? <VariantPicker variants={variants} onPick={index => onInsert(emptyValue(variants[index]!))} trigger={button} /> : button}</span>
    </div>
  );
}

export function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  return useMemo(() => ((...args: never[]) => ref.current(...args)) as T, []);
}
