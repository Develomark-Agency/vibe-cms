import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CodeIcon, PlusIcon, Table2Icon, XIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MAX_TEXT_EDIT_BYTES, textKind, type TextKind } from "../../text-files.ts";
import type { Asset } from "../index.ts";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.tsx";
import { Kbd } from "../components/ui/kbd.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { cn } from "../lib/utils.ts";
import { ApiError } from "./client.ts";
import { useAdmin } from "./context.tsx";
import { formatBytes } from "./pickers.tsx";
import { parseCsv, stringifyCsv } from "./csv.ts";
import { Segmented } from "./segmented.tsx";

const CodeEditor = lazy(() => import("./code-editor.tsx"));

/** Beyond this many cells the table view would be sluggish; the text view still works. */
const MAX_TABLE_CELLS = 20_000;

export function assetTextKind(asset: Asset): TextKind | null {
  return textKind(asset.filename, asset.mime);
}

function delimiterFor(asset: Asset): string {
  return /\.tsv$/i.test(asset.filename) || asset.mime === "text/tab-separated-values" ? "\t" : ",";
}

function useTextContent(asset: Asset, enabled = true) {
  return useQuery({
    // The URL changes with every edit (`?v=`), so it doubles as the cache key.
    queryKey: ["asset-text", asset.url],
    enabled,
    queryFn: async () => {
      const response = await fetch(asset.url);
      if(!response.ok) throw new Error(`Couldn't load the file (${response.status})`);
      return response.text();
    },
    staleTime: Infinity
  });
}

// --- CSV ------------------------------------------------------------------------------

/** Every row padded to the widest, so the grid is rectangular. */
function rectangular(rows: string[][]): string[][] {
  const width = Math.max(1, ...rows.map(r => r.length));
  const filled = rows.length ? rows : [[""]];
  return filled.map(r => (r.length === width ? r : [...r, ...Array.from({ length: width - r.length }, () => "")]));
}

function columnName(index: number): string {
  let name = "";
  for(let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * An editable grid. The first row reads as the header and stays in view.
 * Enter and the up/down arrows move between rows; Tab moves across.
 */
function CsvGrid({ rows, onChange, readOnly }: { rows: string[][], onChange(rows: string[][]): void, readOnly?: boolean }) {
  const table = useRef<HTMLTableElement>(null);
  const width = rows[0]?.length ?? 0;

  function set(r: number, c: number, value: string) {
    onChange(rows.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? value : cell)) : row)));
  }

  function focusCell(r: number, c: number) {
    table.current?.querySelector<HTMLInputElement>(`input[data-cell="${r}:${c}"]`)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>, r: number, c: number) {
    if(event.key === "Enter" || (event.key === "ArrowDown" && !event.altKey)) {
      event.preventDefault();
      if(r === rows.length - 1 && event.key === "Enter" && !readOnly) {
        onChange([...rows, Array.from({ length: width }, () => "")]);
        requestAnimationFrame(() => focusCell(r + 1, c));
      } else {
        focusCell(Math.min(r + 1, rows.length - 1), c);
      }
    } else if(event.key === "ArrowUp") {
      event.preventDefault();
      focusCell(Math.max(r - 1, 0), c);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table ref={table} className="border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-30 h-7 w-10 min-w-10 bg-(--well)" />
              {rows[0]?.map((_, c) => (
                <th key={c} className="group/col sticky top-0 z-20 h-7 min-w-36 border-b border-l border-border bg-(--well) px-2 text-left text-[11px] font-medium text-muted-foreground">
                  <span className="flex items-center justify-between gap-1">
                    {columnName(c)}
                    {!readOnly && width > 1 && (
                      <button type="button" aria-label={`Delete column ${columnName(c)}`} title="Delete column"
                        onClick={() => onChange(rows.map(row => row.filter((_, j) => j !== c)))}
                        className="flex size-5 items-center justify-center rounded-[5px] opacity-0 group-hover/col:opacity-100 hover:bg-foreground/[0.08] focus-visible:opacity-100">
                        <XIcon className="size-3" />
                      </button>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="group/row">
                <th className={cn("sticky left-0 z-10 h-8 border-b border-border bg-(--well) px-1 text-right text-[11px] font-normal text-muted-foreground tabular-nums", r === 0 && "top-7 z-20")}>
                  <span className="flex items-center justify-end gap-0.5">
                    {!readOnly && rows.length > 1 && (
                      <button type="button" aria-label={`Delete row ${r + 1}`} title="Delete row"
                        onClick={() => onChange(rows.filter((_, i) => i !== r))}
                        className="flex size-5 items-center justify-center rounded-[5px] opacity-0 group-hover/row:opacity-100 hover:bg-foreground/[0.08] focus-visible:opacity-100">
                        <XIcon className="size-3" />
                      </button>
                    )}
                    <span className="group-hover/row:hidden">{r + 1}</span>
                  </span>
                </th>
                {row.map((cell, c) => (
                  <td key={c} className={cn("h-8 border-b border-l border-border p-0", r === 0 && "sticky top-7 z-10 bg-card font-medium")}>
                    <input
                      data-cell={`${r}:${c}`}
                      value={cell}
                      readOnly={readOnly}
                      aria-label={`${columnName(c)}${r + 1}`}
                      onChange={e => set(r, c, e.target.value)}
                      onKeyDown={e => onKeyDown(e, r, c)}
                      className="h-8 w-full min-w-36 bg-transparent px-2 outline-none focus:bg-card focus:shadow-[inset_0_0_0_1.5px_var(--code-property)]"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="flex gap-1.5 border-t border-border p-1.5">
          <Button variant="ghost" size="xs" onClick={() => onChange([...rows, Array.from({ length: width }, () => "")])}><PlusIcon /> Row</Button>
          <Button variant="ghost" size="xs" onClick={() => onChange(rows.map(row => [...row, ""]))}><PlusIcon /> Column</Button>
          <span className="ml-auto self-center px-1 text-[11px] text-muted-foreground tabular-nums">{rows.length} × {width}</span>
        </div>
      )}
    </div>
  );
}

// --- Preview -----------------------------------------------------------------------------

/** For the media page's preview pane: a highlighted excerpt, or the first rows of a table. */
export function TextPreview({ asset }: { asset: Asset }) {
  const kind = assetTextKind(asset)!;
  const content = useTextContent(asset, asset.size <= MAX_TEXT_EDIT_BYTES * 4);
  if(asset.size > MAX_TEXT_EDIT_BYTES * 4) return <p className="p-4 text-xs text-muted-foreground">Too large to preview ({formatBytes(asset.size)}).</p>;
  if(content.isLoading) return <div className="flex h-40 items-center justify-center"><Spinner /></div>;
  if(content.isError) return <p className="p-4 text-xs text-destructive">{(content.error as Error).message}</p>;
  const text = content.data ?? "";
  if(kind === "csv") {
    const rows = parseCsv(text.slice(0, 20_000), delimiterFor(asset)).slice(0, 8).map(r => r.slice(0, 4));
    return (
      <div className="max-h-64 overflow-auto p-1">
        <table className="w-full text-[11px]">
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className={cn("border-b border-border last:border-0", r === 0 && "font-medium")}>
                {row.map((cell, c) => <td key={c} className="max-w-28 truncate px-1.5 py-1">{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const excerpt = text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
  return (
    <Suspense fallback={<pre className="max-h-64 overflow-hidden p-3 font-mono text-xs whitespace-pre-wrap">{excerpt}</pre>}>
      <CodeEditor key={asset.url} value={excerpt} kind={kind} delimiter={delimiterFor(asset)} readOnly className="[&_.cm-editor]:max-h-64 [&_.cm-content]:text-xs" />
    </Suspense>
  );
}

// --- Editor -------------------------------------------------------------------------------

/**
 * A large modal around CodeMirror (and the CSV grid). Radii nest: the editor
 * well sits 8px inside the 22px dialog, so its corners are 14px.
 */
export function TextEditorDialog({ asset: initial, open, onOpenChange }: { asset: Asset, open: boolean, onOpenChange(open: boolean): void }) {
  const { cms } = useAdmin();
  const queryClient = useQueryClient();
  // Saving gives the file a new URL (`?v=`); later saves and the size readout follow it.
  const [asset, setAsset] = useState(initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => setAsset(initial), [initial.id]);
  useEffect(() => {
    if(savedAt === null) return;
    const timer = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(timer);
  }, [savedAt]);
  const kind = assetTextKind(asset)!;
  const delimiter = delimiterFor(asset);
  const content = useTextContent(asset, open);
  const [draft, setDraft] = useState<string | null>(null);
  const [mode, setMode] = useState<"table" | "text">("table");
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // Remounts the text editor when the table changed the text underneath it.
  const [textVersion, setTextVersion] = useState(0);

  useEffect(() => {
    if(open) {
      setDraft(null);
      setConfirmClose(false);
    }
  }, [open, initial.id]);

  const original = content.data ?? "";
  const text = draft ?? original;
  const dirty = draft !== null && draft !== original;
  const rows = useMemo(() => (kind === "csv" ? rectangular(parseCsv(text, delimiter)) : []), [kind, text, delimiter]);
  const tableAllowed = kind === "csv" && rows.length * (rows[0]?.length ?? 0) <= MAX_TABLE_CELLS;
  const showTable = tableAllowed && mode === "table";
  const tooLarge = asset.size > MAX_TEXT_EDIT_BYTES;

  async function save() {
    if(!dirty || saving) return;
    const bytes = new TextEncoder().encode(text).byteLength;
    if(bytes > MAX_TEXT_EDIT_BYTES) {
      cms.toast("Text files can be edited up to 1 MB", { type: "error" });
      return;
    }
    setSaving(true);
    try {
      const saved = await cms.actions.assets.replaceContent({ id: asset.id, content: text });
      queryClient.setQueryData(["asset-text", saved.url], text);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["asset-detail", asset.id] }),
        queryClient.invalidateQueries({ queryKey: ["assets"] }),
        queryClient.invalidateQueries({ queryKey: ["asset", asset.id] })
      ]);
      setDraft(null);
      setAsset(saved);
      // Shown in the footer rather than as a toast, which would cover the buttons.
      setSavedAt(Date.now());
    } catch (error) {
      cms.toast(error instanceof ApiError ? error.message : "Couldn't save", { type: "error" });
    } finally {
      setSaving(false);
    }
  }

  function requestClose(next: boolean) {
    if(!next && dirty) setConfirmClose(true);
    else onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(88vh,56rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        onKeyDown={event => {
          // ⌘S also works from the table view.
          if((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void save();
          }
        }}
      >
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2 truncate">
              {asset.filename}
              {dirty && <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" aria-label="Unsaved changes" />}
            </DialogTitle>
            <DialogDescription className="text-xs">{asset.folder ?? "All files"} · {formatBytes(new TextEncoder().encode(text).byteLength)}</DialogDescription>
          </div>
          {kind === "csv" && (
            <Segmented<"table" | "text">
              label="Show as"
              value={showTable ? "table" : "text"}
              onChange={next => {
                setMode(next);
                setTextVersion(v => v + 1);
              }}
              options={[
                { value: "table", label: <><Table2Icon className="size-4" /> Table</>, disabled: !tableAllowed },
                { value: "text", label: <><CodeIcon className="size-4" /> Text</> }
              ]}
            />
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => requestClose(false)}><XIcon /></Button>
        </div>

        <div className="mx-2 min-h-0 flex-1 overflow-hidden rounded-[14px] well">
          {tooLarge ? (
            <p className="p-6 text-sm text-muted-foreground">This file is {formatBytes(asset.size)}; files up to 1 MB can be edited here.</p>
          ) : content.isLoading ? (
            <div className="flex h-full items-center justify-center"><Spinner /></div>
          ) : content.isError ? (
            <p className="p-6 text-sm text-destructive">{(content.error as Error).message}</p>
          ) : showTable ? (
            <CsvGrid rows={rows} onChange={next => setDraft(stringifyCsv(next, delimiter, /\r?\n$/.test(original)))} />
          ) : (
            <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
              <CodeEditor
                key={`${asset.url}:${textVersion}`}
                value={text}
                kind={kind}
                delimiter={delimiter}
                autoFocus
                onChange={setDraft}
                onSave={() => void save()}
                className="h-full"
              />
            </Suspense>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3">
          {confirmClose ? (
            <>
              <p className="flex-1 text-sm">Discard your changes to {asset.filename}?</p>
              <Button variant="outline" onClick={() => setConfirmClose(false)}>Keep editing</Button>
              <Button variant="destructive" onClick={() => onOpenChange(false)}>Discard</Button>
            </>
          ) : (
            <>
              <p className="flex flex-1 items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
                {savedAt !== null && !dirty ? <span className="font-medium text-foreground">Saved</span> : <><Kbd>⌘S</Kbd> to save</>}{savedAt !== null && !dirty ? "" : kind === "markdown" ? " · paste a URL over selected text to link it" : kind === "csv" && showTable ? " · Enter moves down, Tab moves across" : ""}
              </p>
              <Button variant="outline" onClick={() => requestClose(false)}>{dirty ? "Cancel" : "Close"}</Button>
              <Button onClick={() => void save()} disabled={!dirty || saving}>{saving && <Spinner />} Save</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
