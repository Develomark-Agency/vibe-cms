import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, DownloadIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { cn } from "../lib/utils.ts";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Switch } from "../components/ui/switch.tsx";
import type { Redirect } from "../../handler/redirects.ts";
import { askConfirm } from "./confirm.tsx";
import { useAdmin } from "./context.tsx";
import { parseCsv, stringifyCsv } from "./csv.ts";
import { variablesOf } from "../../redirects.ts";
import { Page, PageHeader } from "./page.tsx";
import { Link } from "./router.tsx";

const PAGE = 50;
const STATUSES = [
  { value: 301, label: "301 Permanent" },
  { value: 302, label: "302 Temporary" },
  { value: 307, label: "307 Temporary, same method" },
  { value: 308, label: "308 Permanent, same method" }
];
const SOURCES = { manual: "Added by hand", "slug-change": "Address changed", trash: "Page deleted" } as const;

interface Draft {
  id: string | null,
  from: string,
  to: string,
  status: number,
  keepQuery: boolean
}

const EMPTY: Draft = { id: null, from: "", to: "", status: 301, keepQuery: true };

/** Site → Redirects: where old paths go, served by the site's Worker before its own pages. */
export function RedirectsPage() {
  const { cms, config, site } = useAdmin();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"" | keyof typeof SOURCES>("");
  const [limit, setLimit] = useState(PAGE);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [skipped, setSkipped] = useState<Array<{ row: number, from: string, reason: string }> | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `Redirects · ${site.name}`;
  }, [site.name]);
  // Typing searches a moment after you stop.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setLimit(PAGE);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  const list = useQuery({
    queryKey: ["redirects", query, source, limit],
    queryFn: () => cms.actions.redirects.list({ search: query || undefined, source: source || undefined, limit }),
    placeholderData: previous => previous
  });
  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ["redirects"] });
  }

  const save = useMutation({
    mutationFn: async (value: Draft) => {
      const rule = { from: value.from.trim(), to: value.to.trim(), status: value.status as 301, keepQuery: value.keepQuery };
      return value.id ? cms.actions.redirects.update({ id: value.id, ...rule }) : cms.actions.redirects.create(rule);
    },
    onSuccess(result) {
      setDraft(null);
      void refresh();
      toast.success(result.repointed ? `Saved. ${result.repointed} earlier ${result.repointed === 1 ? "redirect now goes" : "redirects now go"} straight to the new target.` : "Redirect saved");
      for(const warning of result.warnings) toast.warning(warning);
    },
    onError: error => toast.error((error as Error).message)
  });

  const remove = useMutation({
    mutationFn: (id: string) => cms.actions.redirects.delete({ id }),
    onSuccess: () => {
      void refresh();
      toast.success("Redirect deleted");
    },
    onError: error => toast.error((error as Error).message)
  });

  const rows = list.data?.redirects ?? [];
  const total = list.data?.total ?? 0;
  const filtering = query !== "" || source !== "";

  async function exportCsv() {
    const all: Redirect[] = [];
    for(let offset = 0; ; offset += 200) {
      const page = await cms.actions.redirects.list({ limit: 200, offset });
      all.push(...page.redirects);
      if(all.length >= page.total || page.redirects.length === 0) break;
    }
    const csv = stringifyCsv([["from", "to", "status", "keepQuery"], ...all.map(r => [r.from, r.to, String(r.status), String(r.keepQuery)])], ",", true);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = "redirects.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const importCsv = useMutation({
    mutationFn: async (file: File) => {
      const [header, ...body] = parseCsv(await file.text(), ",").filter(row => row.some(cell => cell.trim()));
      // With a header row, columns are found by name; without one they're from, to, status.
      const named = header?.some(cell => /^(from|to|status|keepquery)$/i.test(cell.trim()));
      function column(name: string, fallback: number) {
        return named ? header!.findIndex(cell => cell.trim().toLowerCase() === name) : fallback;
      }
      const [from, to, status, keep] = [column("from", 0), column("to", 1), column("status", 2), column("keepquery", 3)];
      const data = named ? body : header ? [header, ...body] : body;
      const rules = data.map(row => {
        const code = Number(row[status]?.trim());
        return {
          from: row[from]?.trim() ?? "",
          to: row[to]?.trim() ?? "",
          ...(code ? { status: code as 301 } : {}),
          ...(row[keep]?.trim() ? { keepQuery: !/^(false|0|no)$/i.test(row[keep]!.trim()) } : {})
        };
      });
      let created = 0;
      const refused: Array<{ row: number, from: string, reason: string }> = [];
      for(let i = 0; i < rules.length; i += 1000) {
        const result = await cms.actions.redirects.import({ rows: rules.slice(i, i + 1000) });
        created += result.created;
        refused.push(...result.skipped.map(s => ({ ...s, row: s.row + i })));
      }
      return { created, refused };
    },
    onSuccess({ created, refused }) {
      void refresh();
      setSkipped(refused.length ? refused : null);
      toast.success(`Imported ${created} ${created === 1 ? "redirect" : "redirects"}${refused.length ? `, skipped ${refused.length}` : ""}`);
    },
    onError: error => toast.error((error as Error).message)
  });

  return (
    <Page>
      <PageHeader
        eyebrow="Settings"
        title="Redirects"
        summary="Send visitors from an old path to a new one. They apply before the site's own pages are looked up."
        actions={(
          <>
            <input ref={importInput} type="file" accept=".csv,text/csv" hidden onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if(file) importCsv.mutate(file);
            }} />
            <Button variant="ghost" size="sm" disabled={importCsv.isPending} onClick={() => importInput.current?.click()}>
              {importCsv.isPending ? <Spinner /> : <UploadIcon />} Import
            </Button>
            <Button variant="ghost" size="sm" disabled={total === 0 && !filtering} onClick={() => void exportCsv().catch(error => toast.error((error as Error).message))}><DownloadIcon /> Export</Button>
            <Button size="sm" onClick={() => setDraft(EMPTY)}><PlusIcon /> Add redirect</Button>
          </>
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search redirects" placeholder="Search paths" className="pl-8" value={search} onChange={event => setSearch(event.target.value)} />
        </div>
        <select
          aria-label="Filter by source"
          value={source}
          onChange={event => {
            setSource(event.target.value as typeof source);
            setLimit(PAGE);
          }}
          className="h-9 rounded-lg border bg-background px-2.5 text-sm"
        >
          <option value="">All sources</option>
          {Object.entries(SOURCES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>

      {skipped && (
        <section className="flex flex-col gap-2 rounded-[16px] elevated p-4 text-sm" aria-label="Skipped rows">
          <div className="flex items-center justify-between">
            <p className="font-medium">{skipped.length} {skipped.length === 1 ? "row" : "rows"} weren't imported</p>
            <Button variant="ghost" size="sm" onClick={() => setSkipped(null)}>Dismiss</Button>
          </div>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-xs text-muted-foreground">
            {skipped.map(row => <li key={row.row}>Row {row.row}{row.from && <> (<code className="font-mono">{row.from}</code>)</>}: {row.reason}</li>)}
          </ul>
        </section>
      )}

      {!list.data ? (
        <div className="flex justify-center p-12"><Spinner className="size-5" /></div>
      ) : rows.length === 0 ? (
        <section className="rounded-[16px] elevated p-8 text-center text-sm text-muted-foreground">
          {filtering ? "No redirects match." : "No redirects yet."}
          {!filtering && !list.data.hasUrls && <p className="mt-2 text-xs">Content types don't have addresses the editor can work out yet, so renaming a page won't suggest one. Add <code className="font-mono">url</code> to a collection's settings, or use <code className="font-mono">pageSchema()</code>.</p>}
        </section>
      ) : (
        <section className="flex flex-col divide-y rounded-[16px] elevated" aria-label="Redirects">
          {rows.map(row => (
            <div key={row.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  <code className="font-mono break-all">{row.from}</code>
                  <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <code className="font-mono break-all">{row.to}</code>
                </p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <Badge variant="secondary">{row.status}</Badge>
                  <span>{row.hits} {row.hits === 1 ? "hit" : "hits"}{row.lastHitAt && ` · last ${new Date(row.lastHitAt).toLocaleDateString()}`}</span>
                  {row.source === "manual" ? null : row.documentType && row.documentId ? (
                    <Link to={`/content/${row.documentType}/${row.documentId}${row.locale && row.locale !== config.defaultLocale ? `?locale=${row.locale}` : ""}`} className="underline underline-offset-2">{SOURCES[row.source]}: open the page</Link>
                  ) : (
                    <span>{SOURCES[row.source]}</span>
                  )}
                </p>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon-sm" aria-label={`Edit redirect from ${row.from}`} onClick={() => setDraft({ id: row.id, from: row.from, to: row.to, status: row.status, keepQuery: row.keepQuery })}><PencilIcon /></Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Delete redirect from ${row.from}`} onClick={async () => {
                  if(await askConfirm({ title: `Delete the redirect from ${row.from}?`, description: "Visitors to that path get the site's own response again.", action: "Delete", destructive: true })) remove.mutate(row.id);
                }}><Trash2Icon /></Button>
              </div>
            </div>
          ))}
        </section>
      )}

      {list.data && rows.length < total && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setLimit(limit + PAGE)}>Show more ({total - rows.length} left)</Button>
        </div>
      )}

      <Dialog open={draft !== null} onOpenChange={open => !open && setDraft(null)}>
        <DialogContent>
          {draft && (
            <form
              className="flex flex-col gap-5"
              onSubmit={event => {
                event.preventDefault();
                if(draft.from.trim() && draft.to.trim()) save.mutate(draft);
              }}
            >
              <DialogHeader>
                <DialogTitle>{draft.id ? "Edit redirect" : "Add redirect"}</DialogTitle>
                <DialogDescription>End “from” with /* to match everything under a path, and use * in “to” for what it matched: /blog/* → /news/*. Or name segments with {"{name}"} and use them in “to”, path or query: {"/items/{id} → /products?id={id}"}.</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="redirect-from">From</Label>
                <Input id="redirect-from" autoFocus placeholder="/old-page" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="redirect-to">To</Label>
                <TargetInput id="redirect-to" value={draft.to} variables={variablesOf(draft.from)} from={draft.from} onChange={to => setDraft({ ...draft, to })} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="redirect-status">Status</Label>
                <select id="redirect-status" value={draft.status} onChange={event => setDraft({ ...draft, status: Number(event.target.value) })} className="h-9 rounded-lg border bg-background px-2.5 text-sm">
                  {STATUSES.map(status => <option key={status.value} value={status.value}>{status.label}</option>)}
                </select>
              </div>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Keep the query string<span className="block text-xs text-muted-foreground">/old?page=2 goes to /new?page=2</span></span>
                <Switch checked={draft.keepQuery} onCheckedChange={keepQuery => setDraft({ ...draft, keepQuery })} aria-label="Keep the query string" />
              </label>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                <Button type="submit" disabled={!draft.from.trim() || !draft.to.trim() || save.isPending}>{save.isPending && <Spinner />} Save</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </Page>
  );
}

/**
 * The “to” field. With variables in “from” (`/hello/{a}/bye/{b}`), typing `{` lists them to pick from, they
 * can be inserted with a click, and an example shows what a visit becomes. Without any it's a plain input.
 */
function TargetInput({ id, value, variables, from, onChange }: { id: string, value: string, variables: string[], from: string, onChange(value: string): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);

  // An unfinished `{par` before the caret: what's typed so far picks from the variables.
  const open = /\{(\w*)$/.exec(value.slice(0, caret));
  const options = open ? variables.filter(name => name.startsWith(open[1]!)) : [];
  const showing = focused && !dismissed && options.length > 0;
  const unknown = variablesOf(value).filter(name => !variables.includes(name));

  function track(element: HTMLInputElement) {
    setCaret(element.selectionStart ?? element.value.length);
  }

  function place(start: number, end: number, text: string) {
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    const position = start + text.length;
    setCaret(position);
    setDismissed(false);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(position, position);
    });
  }

  function pick(name: string) {
    if(!open) return;
    const start = caret - open[0].length;
    // A closing brace that was already typed isn't doubled.
    place(start, value[caret] === "}" ? caret + 1 : caret, `{${name}}`);
  }

  function example(text: string) {
    return text.replace(/\{(\w+)\}/g, (_, name: string) => name);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Input
          id={id}
          ref={input}
          autoComplete="off"
          placeholder="/new-page or https://example.com/page"
          value={value}
          role={variables.length ? "combobox" : undefined}
          aria-expanded={variables.length ? showing : undefined}
          aria-autocomplete={variables.length ? "list" : undefined}
          onChange={event => {
            onChange(event.target.value);
            track(event.target);
            setDismissed(false);
            setActive(0);
          }}
          onSelect={event => track(event.currentTarget)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={event => {
            if(!showing) return;
            if(event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
            } else if(event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pick(options[Math.min(active, options.length - 1)]!);
            } else if(event.key === "Escape") {
              // Closes the list, not the dialog.
              event.preventDefault();
              event.stopPropagation();
              setDismissed(true);
            }
          }}
        />
        {showing && (
          <ul role="listbox" aria-label="Variables" className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
            {options.map((name, index) => (
              // mousedown, not click: the input keeps focus, so the list doesn't close before the pick.
              <li key={name} role="option" aria-selected={index === active} onMouseDown={event => {
                event.preventDefault();
                pick(name);
              }} onMouseEnter={() => setActive(index)} className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm", index === active && "bg-accent text-accent-foreground")}>
                <code className="font-mono">{`{${name}}`}</code>
                <span className="text-xs text-muted-foreground">from “from”</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {variables.length > 0 && (
        <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <p className="flex flex-wrap items-center gap-1.5">
            Variables:
            {variables.map(name => (
              <button key={name} type="button" onMouseDown={event => event.preventDefault()} onClick={() => place(input.current?.selectionStart ?? value.length, input.current?.selectionEnd ?? value.length, `{${name}}`)} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground hover:bg-accent">{`{${name}}`}</button>
            ))}
            <span>Type <kbd className="font-mono">{"{"}</kbd> to pick one.</span>
          </p>
          {unknown.length > 0 && <p className="text-destructive">{unknown.map(name => `{${name}}`).join(", ")} {unknown.length === 1 ? "isn't" : "aren't"} in “from”.</p>}
          {value.trim() && unknown.length === 0 && (
            <p>Example: <code className="font-mono break-all text-foreground">{example(from)}</code> → <code className="font-mono break-all text-foreground">{example(value)}</code></p>
          )}
        </div>
      )}
    </div>
  );
}
