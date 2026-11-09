/**
 * Coloured text as lines of segments, wrapped to a width before it's drawn, so a scrolling view knows
 * exactly how many rows it has.
 */

export interface Segment {
  text: string,
  color?: string,
  bold?: boolean,
  dim?: boolean,
  italic?: boolean
}

export type Line = Segment[];

/**
 * Splits a line into rows of at most `width` characters, keeping each piece's style. Breaks between
 * words where it can; continuation rows keep the line's indent.
 */
export function wrapLine(line: Line, width: number): Line[] {
  const max = Math.max(1, width);
  const indent = Math.min(/^\s*/.exec(line.map(s => s.text).join(""))![0].length, Math.floor(max / 2));
  const rows: Line[] = [[]];
  let used = 0;
  function newRow() {
    rows.push(indent ? [{ text: " ".repeat(indent) }] : []);
    used = indent;
  }
  for(const segment of line) {
    for(const token of segment.text.match(/\S+|\s+/g) ?? []) {
      const space = /^\s/.test(token);
      if(used + token.length > max && used > indent) {
        if(space) {
          newRow();
          continue;
        }
        if(token.length <= max - indent) newRow();
      }
      let rest = token;
      while(rest.length) {
        if(used >= max) newRow();
        const take = rest.slice(0, max - used);
        rows.at(-1)!.push({ ...segment, text: take });
        used += take.length;
        rest = rest.slice(take.length);
      }
    }
  }
  return rows;
}

export function wrapLines(lines: Line[], width: number): Line[] {
  return lines.flatMap(line => wrapLine(line, width));
}

/** Plain text, one line per line. */
export function plainLines(text: string, style: Omit<Segment, "text"> = {}): Line[] {
  return text.replace(/\t/g, "  ").split("\n").map(line => [{ text: line, ...style }]);
}

const TOKEN = /"(?:[^"\\]|\\.)*"(?=\s*:)|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b/g;

function when(ms: number): string {
  const date = new Date(ms);
  function pad(n: number) {
    return String(n).padStart(2, "0");
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A value as indented JSON, coloured, with times (`…At` fields in milliseconds) also given as dates. */
export function jsonLines(value: unknown): Line[] {
  const text = value === undefined ? "undefined" : JSON.stringify(value, null, 2);
  return text.split("\n").map(raw => {
    const line: Line = [];
    let last = 0;
    let key: string | undefined;
    for(const match of raw.matchAll(TOKEN)) {
      if(match.index > last) line.push({ text: raw.slice(last, match.index) });
      const token = match[0];
      const isKey = token.startsWith("\"") && /^\s*:/.test(raw.slice(match.index + token.length));
      if(isKey) key = token.slice(1, -1);
      line.push({
        text: token,
        color: isKey ? "cyan" : token.startsWith("\"") ? "green" : token === "null" ? "gray" : /^(true|false)$/.test(token) ? "magenta" : "yellow"
      });
      last = match.index + token.length;
    }
    if(last < raw.length) line.push({ text: raw.slice(last) });
    const number = /:\s*(\d{12,13}),?$/.exec(raw);
    if(number && key && /(At|At_|Time|time)$/.test(key)) line.push({ text: `  ${when(Number(number[1]))}`, dim: true });
    return line;
  });
}

/** Inline `code` in cyan, **bold** in bold; the rest as it is. */
function inline(text: string, base: Omit<Segment, "text"> = {}): Line {
  const line: Line = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for(const match of text.matchAll(pattern)) {
    if(match.index > last) line.push({ ...base, text: text.slice(last, match.index) });
    if(match[1] !== undefined) line.push({ ...base, text: match[1], color: "cyan" });
    else line.push({ ...base, text: match[2]!, bold: true });
    last = match.index + match[0].length;
  }
  if(last < text.length) line.push({ ...base, text: text.slice(last) });
  return line.length ? line : [{ ...base, text: "" }];
}

/**
 * Markdown, lightly: headings, code blocks, lists, tables and inline code, without the markup that only
 * helps a renderer. One line out per line in, so a line found in the source can be scrolled to.
 */
export function markdownLines(body: string): Line[] {
  const lines: Line[] = [];
  let fenced = false;
  for(const raw of body.replace(/\t/g, "  ").split("\n")) {
    if(/^\s*```/.test(raw)) {
      fenced = !fenced;
      lines.push([{ text: fenced ? `  ┌ ${raw.trim().slice(3) || "code"}` : "  └", dim: true }]);
      continue;
    }
    if(fenced) {
      lines.push([{ text: "  │ ", dim: true }, { text: raw, color: "cyan" }]);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if(heading) {
      const level = heading[1]!.length;
      lines.push(level === 1 ? [{ text: heading[2]!.toUpperCase(), bold: true, color: "magenta" }] : [{ text: `${"#".repeat(level - 1)} `, dim: true }, ...inline(heading[2]!, { bold: true, color: level === 2 ? "magenta" : undefined })]);
      continue;
    }
    if(/^\s*\|?[\s:-]+\|[\s|:-]*$/.test(raw) && raw.includes("-")) {
      lines.push([{ text: raw.replace(/[^|]/g, "─").replace(/\|/g, "┼"), dim: true }]);
      continue;
    }
    if(/^\s*\|/.test(raw)) {
      const cells = raw.trim().replace(/^\||\|$/g, "").split("|");
      const line: Line = [];
      cells.forEach((cell, i) => {
        if(i) line.push({ text: " │ ", dim: true });
        line.push(...inline(cell.trim()));
      });
      lines.push(line);
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if(bullet) {
      lines.push([{ text: `${bullet[1]}• `, color: "magenta" }, ...inline(bullet[2]!)]);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(raw);
    if(quote) {
      lines.push([{ text: "▍ ", color: "gray" }, ...inline(quote[1]!, { italic: true })]);
      continue;
    }
    lines.push(inline(raw));
  }
  return lines;
}
