/**
 * Whether this render is an editor's draft preview. vibe-cms keeps the preview scope on a global
 * symbol, so this needs no import of the server package (and none of node's APIs in browser bundles).
 */
export function inPreview(): boolean {
  const scope = (globalThis as { [key: symbol]: { getStore(): unknown } | undefined })[Symbol.for("vibe-cms.preview")];
  return scope?.getStore() !== undefined;
}
