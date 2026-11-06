import { ChevronRightIcon, EraserIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { askConfirm } from "./confirm.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { hasMetadataSupport, readMetadata, type PhotoMetadata } from "../../media/metadata.ts";

/**
 * Before uploading photos with location or camera details, the editor asks whether to remove them
 * and shows what's there. Uploading folders always asks, listing what's in them. Loose files
 * without metadata upload without a prompt. `chooseStripMetadata` asks;
 * `<MetadataPromptHost />`, mounted once next to `<ConfirmHost />`, shows it.
 */

interface Found {
  file: File,
  /** Where it is in what was dropped: `"Trip/Day 1/IMG_0001.jpg"`, or just its name. */
  path: string,
  metadata: PhotoMetadata
}

/** A file to upload, and the folder it's in within a dropped folder. */
export interface Pending {
  file: File,
  folder: string | null
}

/** The files that carry metadata, read from their first 256 KB in the browser. */
export async function findMetadata(files: Pending[]): Promise<Found[]> {
  const found: Found[] = [];
  for(const { file, folder } of files) {
    if(!hasMetadataSupport(file.type)) continue;
    const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    const metadata = readMetadata(head, file.type);
    if(metadata.any) found.push({ file, path: folder ? `${folder}/${file.name}` : file.name, metadata });
  }
  // Folders come back in the file system's order; numbers sort as numbers ("Day 2" before "Day 10").
  return found.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** A file in the same upload that the dialog lists without details. */
interface Other {
  path: string,
  /** Videos and other photo formats can carry location too, but aren't read or cleaned here. */
  unchecked: boolean
}

interface Request {
  found: Found[],
  others: Other[],
  /** The top-level folders being uploaded, when there are any. */
  folders: string[],
  suggested: boolean,
  resolve(choices: Choices | null): void
}

/** Whether to remove each photo's details, for the photos that have any. */
export type Choices = Map<File, boolean>;

let current: Request | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(listener => listener());
}

/** Resolves whether to remove each photo's details, or null when the upload is cancelled. */
function askStripMetadata(found: Found[], others: Other[], folders: string[], suggested: boolean): Promise<Choices | null> {
  current?.resolve(null);
  return new Promise(resolve => {
    current = { found, others, folders, suggested, resolve };
    emit();
  });
}

function settle(choices: Choices | null) {
  const request = current;
  current = null;
  emit();
  request?.resolve(choices);
}

/**
 * Whether each photo's upload should strip its metadata: `undefined` when none have any (the
 * server's default applies), the answers when asked, or null when cancelled. Files not in the map
 * follow the server's default.
 */
export async function chooseStripMetadata(files: Pending[], suggested: boolean, folders: string[] = []): Promise<Choices | undefined | null> {
  const found = await findMetadata(files);
  if(found.length === 0 && folders.length === 0) return undefined;
  const listed = new Set(found.map(f => f.file));
  const others = files
    .filter(f => !listed.has(f.file))
    .map(({ file, folder }) => ({
      path: folder ? `${folder}/${file.name}` : file.name,
      unchecked: (file.type.startsWith("video/") || file.type.startsWith("image/")) && !hasMetadataSupport(file.type)
    }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return askStripMetadata(found, others, folders, suggested);
}

/** "location data", "camera details" or both, for the files found. */
function describe(found: Found[]): string {
  const location = found.some(f => f.metadata.location);
  const camera = found.some(f => f.metadata.camera);
  if(location && camera) return "location and camera details";
  if(location) return "location data";
  if(camera) return "camera details";
  return "embedded details";
}

// --- Reading every field (exifr) ----------------------------------------------------

/** exifr's groups: IFD0 and EXIF hold both EXIF tags and XMP's fields of the same namespace. */
const GROUP_NAMES: Record<string, string> = {
  ifd0: "Image",
  exif: "Photo",
  gps: "Location",
  iptc: "IPTC",
  xmp: "XMP",
  tiff: "Image",
  dc: "Description",
  photoshop: "Photoshop",
  aux: "Lens and camera"
};

/** Large or unreadable values that would only fill the list. */
const SKIP = new Set(["MakerNote", "ThumbnailOffset", "ThumbnailLength", "PrintIM", "ApplicationNotes"]);

interface Field {
  name: string,
  value: string
}

interface Group {
  name: string,
  fields: Field[]
}

interface Details {
  summary: Field[],
  groups: Group[]
}

/** Any exifr value as one line of text. */
function show(value: unknown): string {
  if(value instanceof Date) return value.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  if(value instanceof Uint8Array || value instanceof ArrayBuffer) return `${value.byteLength} bytes`;
  if(Array.isArray(value)) return value.map(show).join(", ");
  if(value && typeof value === "object") {
    // XMP's language alternatives: { lang, value }.
    if("value" in value) return show((value as { value: unknown }).value);
    return Object.entries(value).map(([k, v]) => `${k}: ${show(v)}`).join(", ");
  }
  if(typeof value === "number") return String(Math.round(value * 1e6) / 1e6);
  return String(value);
}

function pick(groups: Record<string, Record<string, unknown>>, ...keys: string[]): unknown {
  for(const key of keys) {
    for(const group of Object.values(groups)) {
      if(group && group[key] !== undefined && group[key] !== "") return group[key];
    }
  }
  return undefined;
}

async function readDetails(file: File): Promise<Details> {
  const { default: exifr } = await import("exifr");
  const raw = (await exifr.parse(file, {
    tiff: true,
    exif: true,
    gps: true,
    xmp: true,
    iptc: true,
    icc: false,
    // A PNG's header (size, bit depth, colour type) describes the pixels, not the photo.
    ihdr: false,
    ifd1: false,
    interop: false,
    makerNote: false,
    userComment: true,
    mergeOutput: false
  }).catch(() => null) ?? {}) as Record<string, Record<string, unknown>>;

  const summary: Field[] = [];
  const latitude = pick(raw, "latitude");
  const longitude = pick(raw, "longitude");
  if(typeof latitude === "number" && typeof longitude === "number") summary.push({ name: "Location", value: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` });
  const make = pick(raw, "Make");
  const model = pick(raw, "Model");
  if(make || model) {
    const m = model ? String(model) : "";
    summary.push({ name: "Camera", value: make && !m.toLowerCase().startsWith(String(make).toLowerCase()) ? `${show(make)} ${m}`.trim() : m || show(make) });
  }
  const lens = pick(raw, "LensModel", "Lens");
  if(lens) summary.push({ name: "Lens", value: show(lens) });
  const taken = pick(raw, "DateTimeOriginal", "CreateDate", "DateCreated", "ModifyDate");
  if(taken) summary.push({ name: "Taken", value: show(taken) });
  const software = pick(raw, "Software", "CreatorTool");
  if(software) summary.push({ name: "Software", value: show(software) });
  const comment = pick(raw, "UserComment", "ImageDescription", "description");
  if(comment) summary.push({ name: "Comment", value: show(comment) });

  const groups: Group[] = Object.entries(raw)
    .filter(([, fields]) => fields && typeof fields === "object")
    .map(([key, fields]) => ({
      name: GROUP_NAMES[key] ?? key.toUpperCase(),
      fields: Object.entries(fields)
        .filter(([name, value]) => !SKIP.has(name) && value !== undefined && value !== "")
        .map(([name, value]) => ({ name, value: show(value) }))
    }))
    .filter(group => group.fields.length > 0);
  return { summary, groups };
}

// --- The dialog -------------------------------------------------------------------

export function MetadataPromptHost() {
  const request = useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => current);
  return request ? <MetadataPrompt key={[...request.folders, ...request.found.map(f => f.path)].join("|")} request={request} /> : null;
}

function MetadataPrompt({ request }: { request: Request }) {
  const { found, others, folders } = request;
  const [strip, setStrip] = useState<Choices>(() => new Map(found.map(f => [f.file, request.suggested])));
  const what = describe(found);
  const subject = found.length === 1 ? found[0]!.path : `${found.length} photos`;
  const total = found.length + others.length;
  const fileCount = total === 1 ? "1 file" : `${total} files`;
  const folderName = folders.length === 1 ? `“${folders[0]}”` : `${folders.length} folders`;
  const several = found.length > 1;
  const removing = found.filter(f => strip.get(f.file)).length;
  function setAll(value: boolean) {
    setStrip(new Map(found.map(f => [f.file, value])));
  }
  function setOne(file: File, value: boolean) {
    setStrip(prev => new Map(prev).set(file, value));
  }
  return (
    <AlertDialog open onOpenChange={open => !open && settle(null)}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{folders.length ? `Upload ${folderName}?` : `${found.length === 1 ? "This photo includes" : "These photos include"} ${what}`}</AlertDialogTitle>
          <AlertDialogDescription>
            {folders.length > 0 && `${total === 0 ? "No files, only folders" : fileCount}. `}
            {found.length > 0 && `${subject} ${found.length === 1 ? "has" : "have"} ${folders.length ? what : "details"} that anyone who downloads ${found.length === 1 ? "it" : "them"} from the site can read.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="-mx-1 flex max-h-[45vh] flex-col gap-3 overflow-y-auto px-1">
          {found.map(f => (
            <FileMetadata
              key={f.path}
              file={f.file}
              path={f.path}
              showName={several || others.length > 0}
              strip={several ? { checked: strip.get(f.file) ?? false, onChange: value => setOne(f.file, value) } : undefined}
            />
          ))}
          {others.length > 0 && <OtherFiles others={others} title={found.length ? undefined : (others.length === 1 ? "1 file" : `${others.length} files`)} />}
        </div>
        {found.length > 0 && <label className="flex items-center justify-between gap-4 rounded-lg well px-3 py-2.5 text-sm">
          <span>
            {several ? "Remove location and camera details from all" : "Remove location and camera details"}
            <span className="block text-xs text-muted-foreground">
              {several && `${removing === found.length ? "All" : removing === 0 ? "None" : `${removing} of ${found.length}`} selected. `}Orientation is kept. This can't be undone after upload.
            </span>
          </span>
          {/* Several photos: on only when every one is. Turning it on or off sets them all. */}
          <Switch checked={removing === found.length} onCheckedChange={setAll} />
        </label>}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => settle(strip)}>Upload</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function FileMetadata({ file, path, showName, strip }: {
  file: File,
  path: string,
  showName: boolean,
  /** This photo's own switch, when the dialog has several. */
  strip?: { checked: boolean, onChange(value: boolean): void }
}) {
  const [details, setDetails] = useState<Details | null>(null);
  useEffect(() => {
    let live = true;
    void readDetails(file).then(next => live && setDetails(next));
    return () => {
      live = false;
    };
  }, [file]);
  return (
    <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm">
      {showName && (
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate font-medium" title={path}>
            {path.includes("/") && <span className="text-muted-foreground">{path.slice(0, path.lastIndexOf("/") + 1)}</span>}
            {file.name}
          </p>
          {strip && (
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              Remove
              <Switch size="sm" checked={strip.checked} onCheckedChange={strip.onChange} aria-label={`Remove details from ${path}`} />
            </label>
          )}
        </div>
      )}
      <DetailsView details={details} />
    </div>
  );
}

/** A summary of the important fields, then every field by group. */
function DetailsView({ details, empty = "Embedded metadata this browser can't read in detail." }: { details: Details | null, empty?: string }) {
  const total = details?.groups.reduce((n, g) => n + g.fields.length, 0) ?? 0;
  return (
    <>
      {!details ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" /> Reading details…</p>
      ) : (
        <>
          {details.summary.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {details.summary.map(field => (
                <div key={field.name} className="contents">
                  <dt className="text-muted-foreground">{field.name}</dt>
                  <dd className="min-w-0 break-words">{field.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {total > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground select-none hover:text-foreground">
                <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
                All fields ({total})
              </summary>
              <div className="mt-2 flex flex-col gap-3">
                {details.groups.map(group => (
                  <div key={group.name}>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">{group.name}</p>
                    <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-0.5 text-xs">
                      {group.fields.map(field => (
                        <div key={field.name} className="contents">
                          <dt className="truncate text-muted-foreground" title={field.name}>{field.name}</dt>
                          <dd className="min-w-0 break-words font-mono">{field.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            </details>
          )}
          {details.summary.length === 0 && total === 0 && <p className="text-xs text-muted-foreground">{empty}</p>}
        </>
      )}
    </>
  );
}

/**
 * An uploaded photo's metadata, read from the stored file, with a button to remove it. For the
 * media library's preview pane.
 */
export function StoredMetadata({ url, mime, canWrite, onRemove }: {
  url: string,
  mime: string,
  canWrite: boolean,
  /** Removes the details; resolves once the file is replaced. */
  onRemove(): Promise<unknown>
}) {
  const [details, setDetails] = useState<Details | null>(null);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    let live = true;
    setDetails(null);
    void fetch(url, { cache: "no-store" })
      .then(response => response.blob())
      .then(blob => readDetails(new File([blob], "file", { type: mime })))
      .then(next => live && setDetails(next))
      .catch(() => live && setDetails({ summary: [], groups: [] }));
    return () => {
      live = false;
    };
  }, [url, mime]);
  // What's left after removing is orientation alone, which is kept on purpose.
  const fields = details?.groups.flatMap(g => g.fields) ?? [];
  const removable = fields.some(f => f.name !== "Orientation");
  return (
    <div className="flex flex-col gap-2 text-sm">
      <DetailsView details={details} empty="No location or camera details." />
      {details && !removable && fields.length > 0 && <p className="text-xs text-muted-foreground">Only the orientation is stored, which keeps the photo upright.</p>}
      {canWrite && removable && (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={removing}
          onClick={async () => {
            const ok = await askConfirm({
              title: "Remove location and camera details?",
              description: "The stored file is replaced with a copy without them. Orientation is kept. This can't be undone.",
              action: "Remove",
              destructive: true
            });
            if(!ok) return;
            setRemoving(true);
            try {
              await onRemove();
            } finally {
              setRemoving(false);
            }
          }}
        >
          {removing ? <Spinner /> : <EraserIcon />} Remove details
        </Button>
      )}
    </div>
  );
}

/** The rest of the upload, so a dropped folder's other files aren't a surprise. */
function OtherFiles({ others, title }: { others: Other[], title?: string }) {
  const unchecked = others.filter(o => o.unchecked).length;
  return (
    <details className="group rounded-lg border px-3 py-2.5 text-sm" open={others.length <= 5}>
      <summary className="flex cursor-pointer list-none items-center gap-1 select-none">
        <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        {title ?? `Also uploading ${others.length === 1 ? "1 file" : `${others.length} files`}`}
      </summary>
      {unchecked > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {unchecked === 1 ? "One is a video or image type" : `${unchecked} are videos or image types`} that can't be checked or cleaned here, and may include location data.
        </p>
      )}
      <ul className="mt-2 flex flex-col gap-0.5 text-xs">
        {others.map(o => (
          <li key={o.path} className="flex items-center gap-2" title={o.path}>
            <span className="min-w-0 truncate">
              {o.path.includes("/") && <span className="text-muted-foreground">{o.path.slice(0, o.path.lastIndexOf("/") + 1)}</span>}
              {o.path.slice(o.path.lastIndexOf("/") + 1)}
            </span>
            {o.unchecked && <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">Not checked</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
