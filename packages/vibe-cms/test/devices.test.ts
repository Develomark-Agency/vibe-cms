import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { DEVICES_FILE, devicesJson } from "../scripts/devices.ts";
import { DEVICES, matchesDevice } from "../src/admin/app/devices.ts";

test("the preview's device list matches the installed Playwright (run `bun run devices` to update it)", async () => {
  expect(await readFile(DEVICES_FILE, "utf8")).toBe(devicesJson());
});

test("device search matches the starts of words, in any order", () => {
  function found(search: string) {
    return DEVICES.filter(device => matchesDevice(device, search)).map(device => device.name);
  }
  expect(found("pixel").every(name => name.startsWith("Pixel"))).toBe(true);
  expect(found("pixel")).not.toContain("iPhone X");
  expect(found("pix 9")).toEqual(["Pixel 9 Pro XL", "Pixel 9 Pro", "Pixel 9"]);
  expect(found("15 PRO")).toEqual(["iPhone 15 Pro Max", "iPhone 15 Pro"]);
  expect(found("fold galaxy 7")).toContain("Galaxy Z Fold 7");
  expect(found("apple").length).toBe(DEVICES.filter(device => device.maker === "Apple").length);
  expect(found("")).toHaveLength(DEVICES.length);
  expect(found("ixel")).toEqual([]);
});
