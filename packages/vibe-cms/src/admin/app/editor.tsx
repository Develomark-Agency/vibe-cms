import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClockIcon,
  CheckIcon,
  ChevronLeftIcon,
  CloudUploadIcon,
  EyeIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  HistoryIcon,
  LanguagesIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { emptyValue, validate, type Issue } from "../../schema/validate.ts";
import type { DocumentData } from "../../schema/types.ts";
import type { DocumentState } from "../../handler/engine.ts";
import type { DocumentSlotProps } from "../index.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
import { Input } from "../components/ui/input.tsx";
import { Kbd } from "../components/ui/kbd.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";
import { Crossfade } from "../components/crossfade.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { cn } from "../lib/utils.ts";
import { isActionError } from "../../actions/errors.ts";
import { ApiError } from "./client.ts";
import { Delayed, useArrival } from "./delayed.tsx";
import {
  collectionLabel,
  collectionSchema,
  collectionSettings,
  displayUser,
  documentTitle,
  formatDate,
  formatRelative,
  localeName,
  useAdmin
} from "./context.tsx";
import { Field, FormValueContext } from "./fields.tsx";
import { setEditorPage, showPreview } from "./preview.ts";
import { Link, navigate, setNavigationBlocker } from "./router.tsx";
import { confirmLeave } from "./confirm.tsx";
import { Segmented } from "./segmented.tsx";
import { ActivityList } from "./activity.tsx";
import { StatusBadge, StatusDot } from "./status.tsx";

export type { DocumentState };

/** Fills `{field}`, `{id}` and `{locale}` in a collection's preview template. */
function fillPreview(template: string, doc: DocumentData, id: string, locale: string): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if(key === "locale") return locale;
    if(key === "id") return id;
    const value = doc[key];
    // Slashes stay as they are, so a `{path}` placeholder can hold a whole path.
    return typeof value === "string" || typeof value === "number" ? encodeURIComponent(value).replaceAll("%2F", "/") : "";
  });
}

export function EditorPage({ type, id }: { type: string, id: string | null }) {
  const admin = useAdmin();
  const { cms, config, locale, session, plugins } = admin;
  const queryClient = useQueryClient();
  const schema = collectionSchema(config, type);
  const settings = collectionSettings(config, type);
  const permissions = session.permissions.types[type]!;
  const canWriteLocale = permissions.write && session.permissions.locales.includes(locale);

  const doc = useQuery({
    queryKey: ["document", type, id, locale],
    enabled: id !== null,
    queryFn: () => cms.actions.documents.get({ type, id: id!, locale }),
    retry: false
  });

  const baseline = useMemo<DocumentData | null>(() => {
    if(id === null) return emptyValue(schema) as DocumentData;
    if(!doc.data) return null;
    return doc.data.draft ?? doc.data.fallback ?? (emptyValue(schema) as DocumentData);
  }, [id, doc.data, schema]);

  const [value, setValue] = useState<DocumentData | null>(baseline);
  const arrival = useArrival(value !== null);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  const [showIssues, setShowIssues] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "publish" | "unpublish" | "delete">(null);
  const [conflict, setConflict] = useState<DocumentState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const loadedKey = useRef<string | null>(null);

  // Reset the form when switching document or locale, not on every refetch.
  useEffect(() => {
    const key = `${type}/${id}/${locale}/${baseline ? "ready" : "loading"}`;
    if(loadedKey.current === key) return;
    loadedKey.current = key;
    setValue(baseline);
    setServerIssues(doc.data?.issues ?? []);
    setShowIssues(false);
  }, [type, id, locale, baseline]);

  const isNewTranslation = Boolean(doc.data && !doc.data.exists);
  const dirty = value !== null && baseline !== null && (isNewTranslation || JSON.stringify(value) !== JSON.stringify(baseline));
  const clientIssues = useMemo(() => (value ? validate(schema, value).issues : []), [schema, value]);
  // Server issues (missing references, unsuitable files) are cleared on the next edit.
  const issues = showIssues ? dedupe([...clientIssues, ...serverIssues]) : [];
  const title = documentTitle(config, type, value);

  useEffect(() => {
    document.title = `${title} · ${admin.site.name}`;
  }, [title]);

  // Unsaved-changes guard, for in-app navigation and for leaving the page.
  useEffect(() => {
    if(!dirty) return;
    setNavigationBlocker(confirmLeave);
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      setNavigationBlocker(undefined);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);

  function applyResult(result: DocumentState) {
    queryClient.setQueryData(["document", type, result.id, locale], result);
    void queryClient.invalidateQueries({ queryKey: ["documents", type] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    loadedKey.current = `${type}/${result.id}/${locale}/ready`;
    setValue(result.draft);
    setServerIssues(result.issues ?? []);
  }

  function handleError(error: unknown) {
    if(isActionError(error)) {
      if(error.code === "CONFLICT" && error.data?.updatedAt !== undefined) {
        void cms.actions.documents.get({ type, id: id!, locale }).then(setConflict);
        return;
      }
      if((error.code === "BAD_REQUEST" || error.code === "UNPROCESSABLE_CONTENT") && error.data?.issues) {
        setServerIssues(error.data.issues);
        setShowIssues(true);
        cms.toast(error.message, { type: "error" });
        requestAnimationFrame(() => document.querySelector("[data-invalid]")?.scrollIntoView({ behavior: "smooth", block: "center" }));
        return;
      }
      if(error.code === "CONFLICT" && error.data?.references) {
        cms.toast(`${error.message}. Remove those references first.`, { type: "error" });
        return;
      }
      cms.toast(error.message, { type: "error" });
      return;
    }
    // A request that failed some other way: the network, a gateway, a route that isn't an action.
    if(error instanceof ApiError) {
      cms.toast(error.message, { type: "error" });
      return;
    }
    cms.toast("Something went wrong", { type: "error" });
    console.error(error);
  }

  const save = useCallback(async (options: { publish?: boolean, force?: boolean } = {}) => {
    if(!value || busy) return;
    if(options.publish) {
      setShowIssues(true);
      if(clientIssues.length) {
        cms.toast("Fix the highlighted fields before publishing", { type: "error" });
        requestAnimationFrame(() => document.querySelector("[data-invalid]")?.scrollIntoView({ behavior: "smooth", block: "center" }));
        return;
      }
    }
    setBusy(options.publish ? "publish" : "save");
    try {
      if(id === null) {
        const created = await cms.actions.documents.create({ type, locale, data: value, publish: options.publish });
        applyResult(created);
        setNavigationBlocker(undefined);
        navigate(`/content/${type}/${created.id}${location.search}`, { replace: true });
      } else {
        const result = await cms.actions.documents.update({
          type,
          id,
          locale,
          data: value,
          publish: options.publish,
          baseUpdatedAt: options.force || isNewTranslation ? undefined : doc.data?.updatedAt ?? undefined
        });
        applyResult(result);
      }
      cms.toast(options.publish ? "Published" : "Saved", { type: "success" });
      if(!options.publish && clientIssues.length) setShowIssues(true);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
    }
  }, [value, busy, id, type, locale, doc.data, clientIssues, isNewTranslation]);

  async function action(kind: "unpublish" | "publishOnly") {
    setBusy(kind === "unpublish" ? "unpublish" : "publish");
    try {
      const result = await (kind === "unpublish" ? cms.actions.documents.unpublish : cms.actions.documents.publish)({ type, id: id!, locale });
      applyResult(result);
      cms.toast(kind === "unpublish" ? "Unpublished" : "Published", { type: "success" });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    try {
      const translation = isTranslationOnly();
      const { trash } = await cms.actions.documents.delete({ type, id: id!, locale: translation ? locale : undefined });
      setNavigationBlocker(undefined);
      void queryClient.invalidateQueries({ queryKey: ["documents", type] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["trash"] });
      toast.success(translation ? `${localeName(locale)} translation moved to the trash` : "Moved to the trash", {
        duration: 6000,
        action: {
          label: "Undo",
          async onClick() {
            try {
              await cms.actions.trash.restore({ id: trash });
              void queryClient.invalidateQueries({ queryKey: ["documents", type] });
              void queryClient.invalidateQueries({ queryKey: ["document", type, id] });
              void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              void queryClient.invalidateQueries({ queryKey: ["trash"] });
              if(!translation) navigate(`/content/${type}/${id}`);
            } catch (error) {
              handleError(error);
            }
          }
        }
      });
      if(translation) void doc.refetch();
      else navigate(`/content/${type}`);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  }

  function isTranslationOnly() {
    return locale !== config.defaultLocale && (doc.data?.locales.length ?? 0) > 1;
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        if(canWriteLocale) void save({ publish: event.shiftKey && permissions.publish });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, canWriteLocale]);

  // This document's page on the site, as last saved, for a preview that follows the editor.
  const savedDraft = doc.data?.exists ? doc.data.draft : null;
  const sitePage = settings.preview && id && savedDraft ? fillPreview(settings.preview, savedDraft, id, locale) : null;
  useEffect(() => {
    setEditorPage(sitePage);
    return () => setEditorPage(null);
  }, [sitePage]);

  if(id !== null && doc.isError) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-16 text-center">
        <TriangleAlertIcon className="size-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{(doc.error as ApiError).status === 404 ? "Document not found" : "Couldn't load this document"}</h1>
        <p className="text-sm text-muted-foreground">{(doc.error as Error).message}</p>
        <Button variant="outline" nativeButton={false} render={<Link to={`/content/${type}`} />}>Back to {collectionLabel(config, type).toLowerCase()}</Button>
      </div>
    );
  }

  if(!value) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-8">
        <Delayed>
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-32 w-full" />
        </Delayed>
      </div>
    );
  }

  const status = doc.data?.exists ? doc.data.status : null;
  const slotProps: DocumentSlotProps = { type, id, locale, value, status, cms };
  const actions = plugins.slots["document.actions"]!.filter(a => !a.types || a.types.includes(type));
  const panels = plugins.slots["document.sidebar"]!.filter(p => !p.types || p.types.includes(type));
  // The preview shows the saved draft; "View live page" the published one.
  const previewUrl = settings.preview && status && id ? fillPreview(settings.preview, doc.data?.draft ?? value, id, locale) : null;
  const liveUrl = settings.preview && doc.data?.published && id ? fillPreview(settings.preview, doc.data.published, id, locale) : null;
  const readOnly = !canWriteLocale;

  return (
    <FormValueContext.Provider value={value}>
      <div className={cn("flex min-h-full flex-col", arrival)}>
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-2.5 backdrop-blur-md md:px-6">
          {!settings.singleton && (
            <Button variant="ghost" size="icon-sm" className="-ml-1.5 rounded-[8px] md:-ml-3.5" aria-label="Back" nativeButton={false} render={<Link to={`/content/${type}`} />}>
              <ChevronLeftIcon />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[15px] font-semibold">{id === null ? `New ${collectionLabel(config, type, false).toLowerCase()}` : title}</h1>
              <StatusBadge status={status} />
              {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {previewUrl && (
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Preview" onClick={() => void showPreview(cms, previewUrl)}><EyeIcon /></Button>} />
                <TooltipContent>Preview saved draft</TooltipContent>
              </Tooltip>
            )}
            {id !== null && (
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="History" onClick={() => setHistoryOpen(true)}><HistoryIcon /></Button>} />
                <TooltipContent>Version history</TooltipContent>
              </Tooltip>
            )}
            {actions.map(item => item.component ? <item.component key={item.id} {...slotProps} /> : (
              <Button key={item.id} variant="outline" size="sm" onClick={() => item.run?.(slotProps)}>{item.label}</Button>
            ))}
            {!readOnly && (
              <Button variant="outline" size="sm" onClick={() => void save()} disabled={busy !== null || (!dirty && id !== null)}>
                {busy === "save" ? <Spinner /> : <SaveIcon />} Save
              </Button>
            )}
            {!readOnly && permissions.publish && (
              <Button
                size="sm"
                onClick={() => (dirty || id === null ? void save({ publish: true }) : void action("publishOnly"))}
                disabled={busy !== null || (status === "published" && !dirty)}
              >
                <Crossfade
                  active={busy === "publish" ? "busy" : status === "published" && !dirty ? "published" : "publish"}
                  options={{
                    publish: <><CloudUploadIcon /> Publish</>,
                    busy: <><Spinner /> Publish</>,
                    published: <><CheckIcon /> Published</>
                  }}
                />
              </Button>
            )}
            {id !== null && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More actions"><MoreHorizontalIcon /></Button>} />
                <DropdownMenuContent align="end" className="w-64">
                  <DocumentInfo doc={doc.data} />
                  <DropdownMenuSeparator />
                  {permissions.publish && !readOnly && (
                    <DropdownMenuItem onClick={() => setScheduleOpen(true)}><CalendarClockIcon /> Schedule…</DropdownMenuItem>
                  )}
                  {permissions.publish && !readOnly && status && status !== "draft" && (
                    <DropdownMenuItem onClick={() => void action("unpublish")}><EyeOffIcon /> Unpublish</DropdownMenuItem>
                  )}
                  {liveUrl && (
                    <DropdownMenuItem render={<a href={liveUrl} target="_blank" rel="noreferrer" />}><ExternalLinkIcon /> View live page</DropdownMenuItem>
                  )}
                  {dirty && (
                    <DropdownMenuItem onClick={() => setValue(baseline)}><RotateCcwIcon /> Discard changes</DropdownMenuItem>
                  )}
                  {permissions.delete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                        <Trash2Icon /> {isTranslationOnly() ? `Delete ${localeName(locale)} translation` : "Delete"}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>

        <div className="mx-auto grid w-full max-w-6xl flex-1 gap-8 px-4 py-6 md:px-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <main className="flex min-w-0 flex-col gap-6">
            {config.locales!.length > 1 && id !== null && (
              <LocaleBar type={type} id={id} doc={doc.data} />
            )}
            {isNewTranslation && (
              <div className="flex items-start gap-3 rounded-[14px] bg-sky-500/8 p-3 text-sm shadow-[inset_0_0_0_1px] shadow-sky-500/20">
                <LanguagesIcon className="mt-0.5 size-4 text-sky-600" />
                <p>There's no {localeName(locale)} version yet. The form starts from the {localeName(config.defaultLocale!)} copy; saving creates the translation.</p>
              </div>
            )}
            {readOnly && (
              <div className="rounded-[14px] well p-3 text-sm text-muted-foreground">
                {permissions.write ? `You can't edit the ${localeName(locale)} version.` : "You can view this document but not edit it."}
              </div>
            )}
            {showIssues && issues.length > 0 && (
              <div className="flex items-start justify-between gap-3 rounded-[14px] bg-destructive/8 p-3 text-sm text-destructive shadow-[inset_0_0_0_1px] shadow-destructive/25">
                <div className="flex items-start gap-2">
                  <TriangleAlertIcon className="mt-0.5 size-4" />
                  <p>{issues.length === 1 ? "1 field needs attention" : `${issues.length} fields need attention`} before this can be published.</p>
                </div>
                <Button variant="ghost" size="icon-xs" aria-label="Hide" onClick={() => setShowIssues(false)}><XIcon /></Button>
              </div>
            )}
            <form className="flex flex-col gap-6" onSubmit={e => e.preventDefault()}>
              {Object.entries(schema.shape).map(([key, field]) => (
                <Field
                  key={key}
                  schema={field}
                  name={key}
                  path={[key]}
                  value={value[key]}
                  issues={issues}
                  readOnly={readOnly}
                  doc={{ type, id }}
                  onChange={next => {
                    setServerIssues([]);
                    setValue(prev => {
                      const copy = { ...prev };
                      if(next === undefined) delete copy[key];
                      else copy[key] = next;
                      return copy;
                    });
                  }}
                />
              ))}
            </form>
          </main>
          <aside className="flex flex-col gap-4">
            {doc.data?.schedules.length ? <Schedules type={type} id={id!} doc={doc.data} onChange={applyResult} /> : null}
            {panels.map(panel => (
              <section key={panel.id} className="rounded-[16px] elevated p-4">
                <h3 className="mb-2 text-sm font-medium">{panel.label}</h3>
                <panel.component {...slotProps} />
              </section>
            ))}
            {!readOnly && (
              <p className="hidden text-xs text-muted-foreground lg:block">
                <Kbd>⌘</Kbd> <Kbd>S</Kbd> to save{permissions.publish ? <>, <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>S</Kbd> to publish</> : null}
              </p>
            )}
          </aside>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isTranslationOnly() ? `Delete the ${localeName(locale)} translation?` : `Delete “${title}”?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {isTranslationOnly() ? "Other languages are kept." : "Every language version goes to the trash, with its history. Files it uses stay in the media library."} You can restore it from the trash.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()} disabled={busy === "delete"}>
              {busy === "delete" && <Spinner />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={conflict !== null} onOpenChange={open => !open && setConflict(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Someone else changed this document</AlertDialogTitle>
            <AlertDialogDescription>
              {displayUser(conflict?.updatedBy, session)} saved a newer version {formatRelative(conflict?.updatedAt)}. Load theirs (losing your edits), or overwrite it with yours.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              if(conflict) applyResult(conflict);
              setConflict(null);
            }}>Load theirs</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              setConflict(null);
              void save({ force: true });
            }}>Overwrite</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {id !== null && (
        <>
          <ScheduleDialog open={scheduleOpen} onOpenChange={setScheduleOpen} type={type} id={id} status={status} dirty={dirty} onDone={applyResult} onError={handleError} />
          <HistorySheet open={historyOpen} onOpenChange={setHistoryOpen} type={type} id={id} doc={doc.data} onRestore={applyResult} readOnly={readOnly} />
        </>
      )}
    </FormValueContext.Provider>
  );
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter(issue => {
    const key = `${issue.path.join(".")}:${issue.message}`;
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function LocaleBar({ type, id, doc }: { type: string, id: string, doc: DocumentState | undefined }) {
  const { config, locale, setLocale } = useAdmin();
  return (
    <Segmented
      label={`Language of this ${type} (${id})`}
      value={locale}
      onChange={setLocale}
      options={config.locales!.map(l => {
        const version = doc?.locales.find(v => v.locale === l);
        return {
          value: l,
          label: (
            <>
              {version ? <StatusDot status={version.status} /> : <span className="size-2 rounded-full border border-dashed border-muted-foreground/60" />}
              {localeName(l)}
              {l === config.defaultLocale && <span className="text-[11px] font-normal text-muted-foreground">default</span>}
            </>
          )
        };
      })}
    />
  );
}

function DocumentInfo({ doc }: { doc: DocumentState | undefined }) {
  const { session } = useAdmin();
  const rows: Array<[string, string]> = doc?.exists ? [
    ["Created", formatDate(doc.createdAt)],
    ["Last saved", `${formatRelative(doc.updatedAt)} by ${displayUser(doc.updatedBy, session)}`],
    ["Published", doc.publishedAt ? formatDate(doc.publishedAt) : "Never"]
  ] : [["Status", "Not saved yet"]];
  return (
    <dl className="grid gap-1 px-1.5 py-1 text-xs">
      {rows.map(([label, text]) => (
        <div key={label} className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="truncate text-right">{text}</dd>
        </div>
      ))}
    </dl>
  );
}

function Schedules({ type, id, doc, onChange }: { type: string, id: string, doc: DocumentState, onChange(doc: DocumentState): void }) {
  const { cms, locale } = useAdmin();
  return (
    <section className="rounded-[16px] bg-violet-500/8 p-4 shadow-[inset_0_0_0_1px] shadow-violet-500/20">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-violet-700 dark:text-violet-300">
        <CalendarClockIcon className="size-3.5" /> Scheduled
      </h3>
      <ul className="grid gap-2 text-sm">
        {doc.schedules.map(s => (
          <li key={s.action} className="flex items-center justify-between gap-2">
            <span>{s.action === "publish" ? "Publish" : "Unpublish"} {formatDate(s.runAt)}</span>
            <Button variant="ghost" size="icon-xs" aria-label="Cancel schedule" onClick={async () => {
              onChange(await cms.actions.documents.unschedule({ type, id, locale, action: s.action }));
            }}><XIcon /></Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function toLocalInput(date: Date): string {
  function pad(n: number) {
    return String(n).padStart(2, "0");
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ScheduleDialog({ open, onOpenChange, type, id, status, dirty, onDone, onError }: {
  open: boolean,
  onOpenChange(open: boolean): void,
  type: string,
  id: string,
  status: DocumentState["status"],
  dirty: boolean,
  onDone(doc: DocumentState): void,
  onError(error: unknown): void
}) {
  const { cms, locale } = useAdmin();
  const [action, setAction] = useState<"publish" | "unpublish">("publish");
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3600 * 1000)));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule</DialogTitle>
          <DialogDescription>
            {action === "publish"
              ? "The current saved version is captured now and published at the chosen time. Later edits aren't included."
              : "The document is taken off the site at the chosen time."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Segmented<"publish" | "unpublish">
            label="Action"
            value={action}
            onChange={setAction}
            options={[{ value: "publish", label: "Publish" }, { value: "unpublish", label: "Unpublish", disabled: !status }]}
          />
          <label className="grid gap-1.5 text-sm font-medium">
            Date and time
            <Input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} />
          </label>
          {dirty && action === "publish" && <p className="text-sm text-amber-600">You have unsaved changes; save first if they should be included.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !when} onClick={async () => {
            setBusy(true);
            try {
              onDone(await cms.actions.documents.schedule({ type, id, locale, action, runAt: new Date(when).toISOString() }));
              cms.toast(`Scheduled to ${action} ${formatDate(new Date(when).toISOString())}`, { type: "success" });
              onOpenChange(false);
            } catch (error) {
              onError(error);
            } finally {
              setBusy(false);
            }
          }}>{busy && <Spinner />} Schedule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistorySheet({ open, onOpenChange, type, id, doc, onRestore, readOnly }: {
  open: boolean,
  onOpenChange(open: boolean): void,
  type: string,
  id: string,
  doc: DocumentState | undefined,
  onRestore(doc: DocumentState): void,
  readOnly: boolean
}) {
  const { cms, locale, session, config } = useAdmin();
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<"versions" | "activity">("versions");
  const versions = useQuery({
    queryKey: ["versions", type, id, locale, doc?.updatedAt],
    enabled: open,
    queryFn: () => cms.actions.documents.versions({ type, id, locale })
  });
  const version = useQuery({
    queryKey: ["version", type, id, locale, selected],
    enabled: selected !== null,
    queryFn: () => cms.actions.documents.version({ type, id, locale, ver: selected! })
  });
  const schema = collectionSchema(config, type);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>Version history</SheetTitle>
          <SheetDescription>{tab === "versions" ? "Every publish (and scheduled publish) is kept. Restoring copies a version into the draft." : "Who changed this document, when, and through which channel."}</SheetDescription>
          <Segmented label="History" value={tab} onChange={value => setTab(value as typeof tab)} options={[{ value: "versions", label: "Versions" }, { value: "activity", label: "Activity" }]} />
        </SheetHeader>
        {tab === "activity" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4"><ActivityList filter={{ targetId: id }} compact /></div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[11rem_1fr] overflow-hidden">
            <ul className="overflow-y-auto border-r p-2">
              {versions.data?.versions.length === 0 && <li className="p-2 text-sm text-muted-foreground">Not published yet.</li>}
              {versions.data?.versions.map(v => (
                <li key={v.ver}>
                  <button
                    onClick={() => setSelected(v.ver)}
                    className={cn("w-full rounded-[10px] px-2.5 py-2 text-left text-sm transition-[background-color,box-shadow] hover:bg-foreground/[0.04]", selected === v.ver && "raised")}
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      Version {v.ver}
                      {doc?.publishedVer === v.ver && <span className="size-1.5 rounded-full bg-emerald-500" title="Live" />}
                    </span>
                    <span className="block text-xs text-muted-foreground">{formatRelative(v.createdAt)} · {displayUser(v.author, session)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex min-h-0 flex-col overflow-y-auto p-4">
              {selected === null ? <p className="text-sm text-muted-foreground">Pick a version to see it.</p>
                : !version.data ? <Delayed><Spinner /></Delayed>
                  : (
                    <div className="flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <h4 className="font-medium">Version {selected}</h4>
                        {!readOnly && (
                          <Button size="sm" variant="outline" onClick={async () => {
                            const result = await cms.actions.documents.restoreVersion({ type, id, locale, ver: selected! });
                            onRestore(result);
                            cms.toast(`Version ${selected} restored to the draft`, { type: "success" });
                            onOpenChange(false);
                          }}><RotateCcwIcon /> Restore</Button>
                        )}
                      </div>
                      <div className="pointer-events-none flex flex-col gap-5 opacity-90">
                        {Object.entries(schema.shape).map(([key, field]) => (
                          <Field key={key} schema={field} name={key} path={[key]} value={version.data.data[key]} issues={[]} readOnly doc={{ type, id }} onChange={() => {}} />
                        ))}
                      </div>
                    </div>
                  )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
