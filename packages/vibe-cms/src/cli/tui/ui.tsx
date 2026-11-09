import { Box, Text, useInput, usePaste, type Key } from "ink";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Field, FormValues } from "./fields.ts";
import { wrapLines, type Line } from "./text.ts";
import { useSticky } from "./system.ts";

/** Whether the screen a component is on is the one showing: screens underneath keep their state but take no keys. */
export const ActiveContext = createContext(true);

export function useActive(): boolean {
  return useContext(ActiveContext);
}

/** Keys for this component, only while its screen is showing (and `enabled`). */
export function useKeys(handler: (input: string, key: Key) => void, enabled = true) {
  const active = useActive();
  useInput(handler, { isActive: active && enabled });
}

/** The key hints in the footer, for whichever screen is showing. */
export interface Hint {
  keys: string,
  label: string
}

export const HintsContext = createContext<(hints: Hint[]) => void>(() => {});

export function useHints(hints: Hint[]) {
  const set = useContext(HintsContext);
  const active = useActive();
  const signature = hints.map(h => `${h.keys}:${h.label}`).join("|");
  useEffect(() => {
    if(active) set(hints);
  }, [active, signature]);
}

/** Room for the screen below the header and above the footer. */
export const SizeContext = createContext({ width: 80, height: 24 });

export function useSize() {
  return useContext(SizeContext);
}

export const accent = "magenta";

export function Spinner({ label }: { label?: string }) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame(f => (f + 1) % frames.length), 80);
    return () => clearInterval(timer);
  }, []);
  return <Text><Text color={accent}>{frames[frame]}</Text>{label ? ` ${label}` : ""}</Text>;
}

export function Title({ children, hint }: { children: ReactNode, hint?: string }) {
  return (
    <Box marginBottom={1}>
      <Text bold color={accent}>{children}</Text>
      {hint ? <Text dimColor>  {hint}</Text> : null}
    </Box>
  );
}

export function Segments({ line }: { line: Line }) {
  return (
    <Text wrap="truncate-end">
      {line.length ? line.map((s, i) => <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim} italic={s.italic}>{s.text}</Text>) : " "}
    </Text>
  );
}

/** Backspace arrives as `delete` on many terminals (macOS sends DEL), so both erase backwards. */
function isErase(key: Key) {
  return key.backspace || key.delete;
}

/** A one-line text field: arrows, Home/End, ⌃A/⌃E, ⌃U/⌃K/⌃W, paste. */
export function TextInput({ value, onChange, focus = true, placeholder, width, mask, onSubmit }: {
  value: string,
  onChange: (value: string) => void,
  focus?: boolean,
  placeholder?: string,
  width?: number,
  mask?: boolean,
  onSubmit?: (value: string) => void
}) {
  const [cursor, setCursor] = useState(value.length);
  const at = Math.min(cursor, value.length);
  function edit(next: string, nextCursor: number) {
    onChange(next);
    setCursor(nextCursor);
  }
  useKeys((input, key) => {
    if(key.return) return onSubmit?.(value);
    if(key.leftArrow) return setCursor(Math.max(0, at - 1));
    if(key.rightArrow) return setCursor(Math.min(value.length, at + 1));
    if(key.home || (key.ctrl && input === "a")) return setCursor(0);
    if(key.end || (key.ctrl && input === "e")) return setCursor(value.length);
    if(key.ctrl && input === "u") return edit(value.slice(at), 0);
    if(key.ctrl && input === "k") return edit(value.slice(0, at), at);
    if(key.ctrl && input === "w") {
      const start = value.slice(0, at).replace(/\S+\s*$/, "").length;
      return edit(value.slice(0, start) + value.slice(at), start);
    }
    if(isErase(key)) {
      if(at > 0) edit(value.slice(0, at - 1) + value.slice(at), at - 1);
      return;
    }
    if(key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return;
    if(input) edit(value.slice(0, at) + input + value.slice(at), at + input.length);
  }, focus);
  const active = useActive();
  usePaste(text => {
    const clean = text.replace(/\r?\n/g, " ");
    edit(value.slice(0, at) + clean + value.slice(at), at + clean.length);
  }, { isActive: active && focus });

  const shown = mask ? "•".repeat(value.length) : value;
  if(!value && !focus) return <Text dimColor>{placeholder ?? " "}</Text>;
  if(!focus) return <Text wrap="truncate-end">{shown}</Text>;
  // Scrolls sideways to keep the cursor in view.
  const room = Math.max(4, (width ?? 1000) - 1);
  const start = Math.max(0, at - room + 1);
  const visible = shown.slice(start, start + room);
  const pos = at - start;
  if(!value) return <Text><Text inverse> </Text><Text dimColor>{placeholder ?? ""}</Text></Text>;
  return <Text>{visible.slice(0, pos)}<Text inverse>{visible[pos] ?? " "}</Text>{visible.slice(pos + 1)}</Text>;
}

export interface ListItem {
  id: string,
  label: string,
  /** Shown dimmed after the label. */
  hint?: string,
  /** A section title: shown, but the cursor skips it. */
  heading?: boolean,
  color?: string,
  /** A mark before the label, like a badge. */
  mark?: { text: string, color?: string }
}

function selectable(items: ListItem[], from: number, step: number): number {
  for(let i = from; i >= 0 && i < items.length; i += step) if(!items[i]!.heading) return i;
  return -1;
}

/** A list to move through with ↑↓ (and j/k), PgUp/PgDn and Home/End. Enter picks. */
export function List({ items, height, focus = true, onSelect, onHighlight, stickyKey, vim = true, width }: {
  items: ListItem[],
  height: number,
  focus?: boolean,
  onSelect?: (item: ListItem) => void,
  onHighlight?: (item: ListItem | undefined) => void,
  /** Remembers the highlighted item for the session under this key. */
  stickyKey?: string,
  /** j/k move too; off where letters are typed into a filter. */
  vim?: boolean,
  width?: number
}) {
  const [ownKey] = useState(() => `list:${Math.random()}`);
  const [highlighted, setHighlighted] = useSticky<string | undefined>(stickyKey ?? ownKey, undefined);
  let index = items.findIndex(item => item.id === highlighted && !item.heading);
  if(index < 0) index = selectable(items, 0, 1);
  const current = index >= 0 ? items[index] : undefined;
  useEffect(() => onHighlight?.(current), [current?.id, items]);

  function move(to: number, step: number) {
    const clamped = Math.max(0, Math.min(items.length - 1, to));
    const next = selectable(items, clamped, step) >= 0 ? selectable(items, clamped, step) : selectable(items, clamped, -step);
    if(next >= 0) setHighlighted(items[next]!.id);
  }
  useKeys((input, key) => {
    if(key.upArrow || (vim && input === "k")) move(index - 1, -1);
    else if(key.downArrow || (vim && input === "j")) move(index + 1, 1);
    else if(key.pageUp) move(index - Math.max(1, height - 1), -1);
    else if(key.pageDown) move(index + Math.max(1, height - 1), 1);
    else if(key.home) move(0, 1);
    else if(key.end) move(items.length - 1, -1);
    else if(key.return && current) onSelect?.(current);
  }, focus);

  // Keeps the highlighted row in view, with the section title above it when there's room.
  const rows = Math.max(1, height);
  let top = Math.max(0, Math.min(index - Math.floor(rows / 2), items.length - rows));
  if(index >= 0 && index - top > rows - 1) top = index - rows + 1;
  const visible = items.slice(top, top + rows);
  return (
    <Box flexDirection="column" width={width}>
      {visible.map(item => {
        if(item.heading) return <Text key={item.id} dimColor bold>{item.label}</Text>;
        const on = item.id === current?.id;
        return (
          <Text key={item.id} wrap="truncate-end">
            <Text color={on ? accent : undefined}>{on ? "❯ " : "  "}</Text>
            {item.mark ? <Text color={item.mark.color}>{item.mark.text} </Text> : null}
            <Text bold={on} color={on ? (focus ? "white" : undefined) : item.color}>{item.label}</Text>
            {item.hint ? <Text dimColor>  {item.hint}</Text> : null}
          </Text>
        );
      })}
      {items.length > rows ? <Text dimColor>{`  ${items.slice(0, index + 1).filter(i => !i.heading).length}/${items.filter(i => !i.heading).length}`}</Text> : null}
    </Box>
  );
}

/** Scrolls through coloured lines: ↑↓ j/k, PgUp/PgDn or space/b, g/G for the ends. */
export function Viewer({ lines, height, width, focus = true, start = 0, wrap = true }: {
  lines: Line[],
  height: number,
  width: number,
  focus?: boolean,
  /** The source line to open at. */
  start?: number,
  wrap?: boolean
}) {
  const rows = useMemo(() => wrap ? lines.map(line => wrapLines([line], width)) : lines.map(line => [line]), [lines, width, wrap]);
  const flat = useMemo(() => rows.flat(), [rows]);
  const startRow = useMemo(() => rows.slice(0, start).reduce((n, r) => n + r.length, 0), [rows, start]);
  const room = Math.max(1, height - 1);
  const maxTop = Math.max(0, flat.length - room);
  const [top, setTop] = useState(Math.min(startRow, maxTop));
  useEffect(() => setTop(Math.min(startRow, maxTop)), [startRow, lines]);
  const at = Math.min(top, maxTop);
  function scroll(to: number) {
    return setTop(Math.max(0, Math.min(maxTop, to)));
  }
  useKeys((input, key) => {
    if(key.upArrow || input === "k") scroll(at - 1);
    else if(key.downArrow || input === "j") scroll(at + 1);
    else if(key.pageUp || input === "b") scroll(at - room + 1);
    else if(key.pageDown || input === " ") scroll(at + room - 1);
    else if(key.home || input === "g") scroll(0);
    else if(key.end || input === "G") scroll(maxTop);
  }, focus);
  const end = Math.min(flat.length, at + room);
  return (
    <Box flexDirection="column" height={height}>
      {flat.slice(at, at + room).map((line, i) => <Segments key={at + i} line={line} />)}
      <Box flexGrow={1} />
      <Text dimColor>{flat.length > room ? `── ${at + 1}–${end} of ${flat.length} ${"·".repeat(Math.max(0, Math.round((end / flat.length) * 10)))}` : " "}</Text>
    </Box>
  );
}

function describeValue(field: Field, value: FormValues[string]): ReactNode {
  if(field.kind === "boolean") {
    if(value === true) return <Text color="green">◉ yes</Text>;
    if(value === false) return <Text color="red">○ no</Text>;
    return <Text dimColor>○ {field.placeholder ?? "not set"}</Text>;
  }
  if(field.kind === "enum") return value ? <Text><Text dimColor>‹ </Text>{String(value)}<Text dimColor> ›</Text></Text> : <Text dimColor>‹ {field.placeholder ?? "not set"} ›</Text>;
  return null;
}

/** Cycles a field's value: booleans through yes/no (and unset when optional), enums through their options. */
function cycle(field: Field, value: FormValues[string], step: 1 | -1): FormValues[string] {
  const choices: Array<FormValues[string]> = field.kind === "boolean"
    ? field.required ? [true, false] : [undefined, true, false]
    : [...field.required ? [] : [undefined], ...field.options ?? []];
  const index = choices.indexOf(value === "" ? undefined : value);
  return choices[(index + step + choices.length) % choices.length];
}

/**
 * A form: a row per field and a button. Text fields take typing as soon as they're highlighted;
 * yes/no and choices change with Space or ←→. Enter moves on, and runs from the button; ⌃R runs from anywhere.
 */
export function Form({ fields, values, onChange, onSubmit, focus = true, submitLabel = "Run", stickyKey, width = 80, busy }: {
  fields: Field[],
  values: FormValues,
  onChange: (values: FormValues) => void,
  onSubmit: () => void,
  focus?: boolean,
  submitLabel?: string,
  stickyKey: string,
  width?: number,
  busy?: boolean
}) {
  const [row, setRow] = useSticky(`${stickyKey}:row`, 0);
  const at = Math.min(row, fields.length);
  const field = fields[at];
  function set(key: string, value: FormValues[string]) {
    return onChange({ ...values, [key]: value });
  }
  useKeys((input, key) => {
    if(key.ctrl && (input === "r" || input === "s")) return onSubmit();
    if(key.upArrow || (key.tab && key.shift)) return setRow(Math.max(0, at - 1));
    if(key.downArrow || key.tab) return setRow(Math.min(fields.length, at + 1));
    if(!field) {
      if(key.return) onSubmit();
      return;
    }
    if(field.kind === "boolean" || field.kind === "enum") {
      if(input === " " || key.rightArrow) set(field.key, cycle(field, values[field.key], 1));
      else if(key.leftArrow) set(field.key, cycle(field, values[field.key], -1));
      else if(key.return) setRow(at + 1);
      return;
    }
    if(key.return) setRow(at + 1);
  }, focus && !busy);

  const labelWidth = Math.min(24, Math.max(6, ...fields.map(f => (f.label ?? f.key).length + (f.required ? 1 : 0))));
  const inputWidth = Math.max(10, width - labelWidth - 6);
  return (
    <Box flexDirection="column">
      {fields.map((f, i) => {
        const on = i === at && focus;
        const value = values[f.key];
        const special = describeValue(f, value);
        return (
          <Box key={f.key}>
            <Text color={on ? accent : undefined}>{on ? "❯ " : "  "}</Text>
            <Box width={labelWidth + 2} flexShrink={0}>
              <Text bold={on} wrap="truncate-end">{f.label ?? f.key}{f.required ? <Text color={accent}>*</Text> : null}</Text>
            </Box>
            <Box width={inputWidth}>
              {special ?? <TextInput value={typeof value === "string" ? value : ""} onChange={next => set(f.key, next)} focus={on && !busy} placeholder={f.placeholder} width={inputWidth} />}
            </Box>
          </Box>
        );
      })}
      <Box marginTop={fields.length ? 1 : 0}>
        <Text color={accent}>{at === fields.length && focus ? "❯ " : "  "}</Text>
        {busy ? <Spinner label="Running…" /> : <Text inverse={at === fields.length && focus} bold color={at === fields.length && focus ? accent : undefined}>{` ${submitLabel} `}</Text>}
        {!busy ? <Text dimColor>  ⌃R from anywhere</Text> : null}
      </Box>
      <Box marginTop={1} height={2}>
        {field ? (
          <Text dimColor wrap="wrap">
            {[field.description, kindHelp(field), field.required ? "required" : undefined].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

function kindHelp(field: Field): string | undefined {
  switch(field.kind) {
    case "boolean": return "space or ←→ to change";
    case "enum": return `${field.options?.join(" | ")} · space or ←→ to change`;
    case "json": return "JSON, or @path/to/file.json";
    case "file": return "a file path";
    case "strings": return "comma-separated";
    case "number": return "a number";
    default: return field.nullable ? "\"null\" clears it" : undefined;
  }
}

/** A yes/no question over the screen's content: y or Enter on Yes; n or Esc. */
export function Confirm({ message, detail, onAnswer, danger, yesLabel = "Yes" }: { message: string, detail?: string, onAnswer: (yes: boolean) => void, danger?: boolean, yesLabel?: string }) {
  const [yes, setYes] = useState(false);
  useKeys((input, key) => {
    if(input === "y") onAnswer(true);
    else if(input === "n" || key.escape) onAnswer(false);
    else if(key.leftArrow || key.rightArrow || key.tab) setYes(v => !v);
    else if(key.return) onAnswer(yes);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={danger ? "red" : accent} paddingX={1}>
      <Text bold>{message}</Text>
      {detail ? <Text dimColor>{detail}</Text> : null}
      <Box marginTop={1}>
        <Text inverse={yes} color={danger ? "red" : accent} bold>{` ${yesLabel} `}</Text>
        <Text>  </Text>
        <Text inverse={!yes} bold>{" No "}</Text>
        <Text dimColor>   y / n</Text>
      </Box>
    </Box>
  );
}

/** A transient line at the bottom of a screen, like "Copied". */
export function useFlash(): [string | undefined, (message: string) => void] {
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    if(!message) return;
    const timer = setTimeout(() => setMessage(undefined), 2000);
    return () => clearTimeout(timer);
  }, [message]);
  return [message, setMessage];
}

export function ErrorBox({ title, message, children }: { title: string, message?: string, children?: ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text color="red" bold>✗ {title}</Text>
      {message ? <Text wrap="wrap">{message}</Text> : null}
      {children}
    </Box>
  );
}
