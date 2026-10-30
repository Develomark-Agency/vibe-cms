import { expect, test } from "bun:test";
import { parseCsv, stringifyCsv } from "../src/admin/app/csv.ts";

test("CSV round-trips quotes, delimiters and line breaks", () => {
  const text = "name,notes\nFlat white,\"Oat, almond\"\n\"Cold \"\"brew\"\"\",\"two\nlines\"\r\nplain, padded \n";
  const rows = parseCsv(text, ",");
  expect(rows).toEqual([["name", "notes"], ["Flat white", "Oat, almond"], ["Cold \"brew\"", "two\nlines"], ["plain", " padded "]]);
  expect(parseCsv(stringifyCsv(rows, ",", true), ",")).toEqual(rows);
  expect(stringifyCsv([["a\tb", "c"]], "\t", false)).toBe("\"a\tb\"\tc");
});
