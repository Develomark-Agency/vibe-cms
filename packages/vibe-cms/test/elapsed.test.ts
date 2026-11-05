import { describe, expect, test } from "bun:test";
import { formatElapsed } from "../src/cli/backups.ts";

describe("elapsed time", () => {
  test("reads the way people say it", () => {
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(850)).toBe("850ms");
    expect(formatElapsed(8_400)).toBe("8.4s");
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(59_600)).toBe("1m 00s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatElapsed(3_780_000)).toBe("1h 03m");
  });
});
