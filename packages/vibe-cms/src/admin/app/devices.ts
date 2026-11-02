import list from "./devices.json";

/** A device from Playwright's descriptors, as `scripts/devices.ts` writes them to `devices.json`. */
export interface Device {
  name: string,
  maker: "Apple" | "Google" | "Samsung" | "Other",
  /** The page's viewport in CSS pixels, below the browser's own bars. */
  width: number,
  height: number,
  /** The whole screen. */
  screen: { width: number, height: number },
  /** Device pixels per CSS pixel, for reference: a frame can't emulate it. */
  scale: number
}

export const DEVICES = list as Device[];

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);
}

/**
 * Whether every word searched for starts a word of the device's name or maker: "pix 9" finds the
 * Pixel 9s, "15 pro" the iPhone 15 Pros, "apple" every Apple device. An empty search matches all.
 */
export function matchesDevice(device: Device, search: string): boolean {
  const own = words(`${device.name} ${device.maker}`);
  return words(search).every(word => own.some(part => part.startsWith(word)));
}
