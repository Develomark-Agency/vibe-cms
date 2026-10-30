/**
 * A small labelled chip as a drag image. The browser's own snapshot of an
 * element inside the page's view-transition layer can come out as a large,
 * offset slice of the screen, so drags supply this instead.
 */
export function setDragChip(event: DragEvent | React.DragEvent, label: string) {
  const chip = document.createElement("div");
  chip.className = "fixed top-0 left-[-9999px] z-50 max-w-72 truncate rounded-[12px] floating px-3 py-2 text-sm font-medium text-popover-foreground";
  chip.textContent = label;
  document.body.appendChild(chip);
  event.dataTransfer?.setDragImage(chip, 14, 14);
  setTimeout(() => chip.remove());
}
