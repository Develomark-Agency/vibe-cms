// Test preload: gives `bun test` a browser-like global scope (window, document,
// location, ...) so admin UI modules can be imported without per-module guards.
//
// Only globals Bun doesn't already have are added. happy-dom's own Response,
// fetch, URL and stream classes would otherwise replace Bun's and break server
// code under test (a happy-dom Response is not a Bun Response).
import { GlobalWindow } from "happy-dom";

const window = new GlobalWindow({ url: "http://localhost/", console });
const g = globalThis as Record<string | symbol, unknown>;

for(const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(window))) {
  if(key in g) continue;
  // Properties that point back at the window (`window`, `self`, `top`, `parent`)
  // point at the global object instead, so `window.location === location`.
  const value = descriptor.value === window ? globalThis : descriptor.value;
  Object.defineProperty(g, key, { ...descriptor, ...("value" in descriptor ? { value } : {}), configurable: true });
}
