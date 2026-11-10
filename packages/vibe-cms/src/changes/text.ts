/**
 * Word-level text diffs for showing long changes: which words were added and removed, and the
 * stretches of a long text worth showing around them. Pure, for the editor's review dialog.
 */

export type DiffPart = { op: "same" | "add" | "remove", text: string };

/** Above this many word pairs, the diff is by paragraph instead, so a huge text stays quick. */
const MAX_CELLS = 2_000_000;

function tokens(text: string): string[] {
  return text.split(/(\s+)/).filter(Boolean);
}

/** The longest-common-subsequence diff of two token lists, merged into runs. */
function diffTokens(a: string[], b: string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for(let i = n - 1; i >= 0; i--) {
    for(let j = m - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const out: DiffPart[] = [];
  function push(op: DiffPart["op"], text: string) {
    const last = out[out.length - 1];
    if(last && last.op === op) last.text += text;
    else out.push({ op, text });
  }
  let i = 0;
  let j = 0;
  while(i < n && j < m) {
    if(a[i] === b[j]) {
      push("same", a[i]!);
      i++;
      j++;
    } else if(table[i + 1]![j]! >= table[i]![j + 1]!) push("remove", a[i++]!);
    else push("add", b[j++]!);
  }
  while(i < n) push("remove", a[i++]!);
  while(j < m) push("add", b[j++]!);
  return out;
}

/** What changed between two texts, word by word (or paragraph by paragraph when they're very long). */
export function textDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  return tidy(a.length * b.length <= MAX_CELLS ? diffTokens(a, b) : diffTokens(before.split(/(\n+)/), after.split(/(\n+)/)));
}

/**
 * Reads as edits, not word soup: changes separated only by spaces become one removal and one addition
 * ("the" → "our whole", not "the" → "our", " ", "whole ").
 */
function tidy(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let removed = "";
  let added = "";
  function flush() {
    if(removed) out.push({ op: "remove", text: removed });
    if(added) out.push({ op: "add", text: added });
    removed = "";
    added = "";
  }
  for(const [i, part] of parts.entries()) {
    const between = part.op === "same" && !part.text.trim() && (removed || added) && parts[i + 1] && parts[i + 1]!.op !== "same";
    if(part.op === "remove" || between) removed += part.text;
    if(part.op === "add" || between) added += part.text;
    if(part.op === "same" && !between) {
      flush();
      out.push(part);
    }
  }
  flush();
  return out;
}

/** Whether a text is long enough to show as a diff rather than as old and new side by side. */
export function isLongText(...values: unknown[]): boolean {
  return values.some(value => typeof value === "string" && (value.length > 80 || value.includes("\n")));
}

/**
 * The parts to show by default: every change, with up to `context` words of unchanged text around it,
 * and `…` for what's left out. Returns whether anything was left out.
 */
export function trimDiff(parts: DiffPart[], context = 8): { parts: DiffPart[], trimmed: boolean } {
  let trimmed = false;
  const out: DiffPart[] = [];
  for(const [i, part] of parts.entries()) {
    if(part.op !== "same") {
      out.push(part);
      continue;
    }
    const words = tokens(part.text);
    const keepStart = i > 0 ? context * 2 : 0;
    const keepEnd = i < parts.length - 1 ? context * 2 : 0;
    if(words.length <= keepStart + keepEnd + 2) {
      out.push(part);
      continue;
    }
    trimmed = true;
    const head = words.slice(0, keepStart).join("");
    const tail = words.slice(words.length - keepEnd).join("");
    out.push({ op: "same", text: `${head}${head ? " … " : "… "}${tail}` });
  }
  return { parts: out, trimmed };
}

/**
 * The readable text of a structured value, such as rich text: every `text` string, with blocks on
 * their own lines. Null when it has none, so the caller can say only that it changed.
 */
export function plainText(value: unknown): string | null {
  const lines: string[] = [];
  function inline(node: unknown): string {
    if(typeof node === "string") return "";
    if(Array.isArray(node)) return node.map(inline).join("");
    if(node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      return (typeof record.text === "string" ? record.text : "") + (record.children ? inline(record.children) : "");
    }
    return "";
  }
  const blocks = Array.isArray(value) ? value : [value];
  for(const block of blocks) {
    const line = inline(block);
    if(line) lines.push(line);
  }
  return lines.length ? lines.join("\n") : null;
}
