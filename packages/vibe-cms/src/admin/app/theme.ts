/**
 * Switches the `dark` class with every CSS transition suppressed for that
 * frame, so the whole page changes at once instead of some parts fading and
 * others snapping.
 */
export function setDark(dark: boolean) {
  const root = document.documentElement;
  if(root.classList.contains("dark") === dark) return;
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.appendChild(style);
  root.classList.toggle("dark", dark);
  // Force the new styles to apply before transitions come back.
  void getComputedStyle(root).color;
  // A timeout rather than a frame: frames never come in a background tab.
  setTimeout(() => style.remove(), 1);
}
