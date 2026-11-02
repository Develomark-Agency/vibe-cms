/**
 * Writes `src/admin/app/devices.json`, the preview's device list, from Playwright's device
 * descriptors (a dev dependency, so sites don't install it). `test/devices.test.ts` fails when the
 * installed Playwright knows a different list: run `bun run devices` after bumping it.
 */
import { writeFile } from "node:fs/promises";
import { devices } from "playwright-core";
import type { Device } from "../src/admin/app/devices.ts";

export const DEVICES_FILE = new URL("../src/admin/app/devices.json", import.meta.url);

function maker(name: string): Device["maker"] {
  if(/^iP(hone|ad)/.test(name)) return "Apple";
  if(/^(Pixel|Nexus)/.test(name)) return "Google";
  if(name.startsWith("Galaxy")) return "Samsung";
  return "Other";
}

/** Portrait entries only (the preview rotates), no desktop browsers (the ratio presets cover those); newest first. */
export function deviceList(): Device[] {
  return Object.entries(devices)
    .filter(([name]) => !name.endsWith(" landscape") && !name.startsWith("Desktop "))
    .map(([name, d]) => ({
      name,
      maker: maker(name),
      width: d.viewport.width,
      height: d.viewport.height,
      // Present at runtime, missing from the published type.
      screen: (d as { screen?: Device["screen"] }).screen ?? d.viewport,
      scale: d.deviceScaleFactor
    }))
    .reverse();
}

export function devicesJson(): string {
  return `${JSON.stringify(deviceList(), null, 2)}\n`;
}

if(import.meta.main) {
  await writeFile(DEVICES_FILE, devicesJson());
  console.log(`Wrote ${deviceList().length} devices`);
}
