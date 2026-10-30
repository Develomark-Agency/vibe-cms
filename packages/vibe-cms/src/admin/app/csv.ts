/** RFC 4180: quoted fields may hold delimiters, quotes ("") and line breaks. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for(let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if(quoted) {
      if(char === "\"") {
        if(text[i + 1] === "\"") {
          field += "\"";
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if(char === "\"" && field === "") {
      quoted = true;
    } else if(char === delimiter) {
      row.push(field);
      field = "";
    } else if(char === "\n" || char === "\r") {
      if(char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if(field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function stringifyCsv(rows: string[][], delimiter: string, trailingNewline: boolean): string {
  const needsQuotes = new RegExp(`["\\r\\n${delimiter === "\t" ? "\\t" : delimiter}]|^\\s|\\s$`);
  const text = rows.map(row => row.map(cell => (needsQuotes.test(cell) ? `"${cell.replaceAll("\"", "\"\"")}"` : cell)).join(delimiter)).join("\n");
  return trailingNewline ? `${text}\n` : text;
}
