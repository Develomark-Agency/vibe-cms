import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { SiteSettings, SiteSettingsPatch } from "../../handler/engine.ts";
import { SiteMark } from "../components/site-mark.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { cn } from "../lib/utils.ts";
import { useAdmin } from "./context.tsx";
import { MediaLibraryDialog } from "./pickers.tsx";
import { getPanelAccent, postToPanel } from "./session.ts";
import { setAccent } from "./theme.ts";

const SWATCHES = ["#e11d48", "#c026d3", "#7c3aed", "#2563eb", "#0891b2", "#059669", "#65a30d", "#ca8a04", "#57534e"];

export function SiteSettingsPage() {
  const { cms, site, session } = useAdmin();
  const queryClient = useQueryClient();
  const [name, setName] = useState(site.name);
  const [accent, setAccentDraft] = useState<string | null>(site.accent);
  const [icon, setIcon] = useState(site.icon);
  const [stripMetadata, setStripMetadata] = useState(site.stripMetadata);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const dirty = name.trim() !== site.name || accent !== site.accent || icon?.id !== site.icon?.id || stripMetadata !== site.stripMetadata;

  useEffect(() => {
    document.title = `Site · ${site.name}`;
  }, [site.name]);

  // The whole editor previews the accent while it's being chosen.
  useEffect(() => {
    setAccent(accent ?? getPanelAccent());
  }, [accent]);
  useEffect(() => () => setAccent(queryClient.getQueryData<SiteSettings>(["site"])?.accent ?? getPanelAccent()), []);

  const save = useMutation({
    mutationFn: (patch: SiteSettingsPatch) => cms.actions.site.update(patch),
    onSuccess(next) {
      queryClient.setQueryData(["site"], next);
      postToPanel({ type: "vibe:site", site: next });
      setName(next.name);
      toast.success("Site settings saved");
    },
    onError(error) {
      toast.error((error as Error).message);
    }
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if(!dirty || !name.trim()) return;
    // Only what changed: sending the shown name would store the default as an override.
    const patch: SiteSettingsPatch = {};
    if(name.trim() !== site.name) patch.name = name.trim();
    if(accent !== site.accent) patch.accent = accent;
    if(icon?.id !== site.icon?.id) patch.icon = icon?.id ?? null;
    if(stripMetadata !== site.stripMetadata) patch.stripMetadata = stripMetadata;
    save.mutate(patch);
  }

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6 md:px-8">
      <header className="space-y-2 pt-6">
        <h1 className="text-3xl font-medium tracking-[-0.03em]">Site</h1>
        <p className="text-sm text-muted-foreground">How this site appears in the editor, in your agency's panel and in browser tabs.</p>
      </header>

      <section className="flex flex-col gap-6 rounded-[16px] elevated p-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="site-name">Name</Label>
          <Input id="site-name" value={name} maxLength={80} onChange={event => setName(event.target.value)} />
        </div>

        <div className="flex flex-col gap-2">
          <Label id="site-accent">Accent colour</Label>
          {/* Swatches sit in a 4px-padded well: 16px circles inside, a 20px pill outside. */}
          <div role="radiogroup" aria-labelledby="site-accent" className="flex w-fit flex-wrap items-center gap-1 rounded-[20px] well p-1">
            <Swatch label="Default" selected={accent === null} onSelect={() => setAccentDraft(null)} className="bg-foreground [&_svg]:text-background" />
            {SWATCHES.map(color => (
              <Swatch key={color} label={color} selected={accent === color} onSelect={() => setAccentDraft(color)} style={{ background: color }} />
            ))}
            <label
              title="Custom colour"
              className={cn(
                "relative flex size-8 cursor-pointer items-center justify-center rounded-full bg-[conic-gradient(from_90deg,#f43f5e,#eab308,#22c55e,#06b6d4,#6366f1,#d946ef,#f43f5e)] transition-[scale] duration-150 active:scale-90",
                accent !== null && !SWATCHES.includes(accent) && "ring-2 ring-foreground ring-offset-2 ring-offset-(--well)"
              )}
            >
              <input
                type="color"
                aria-label="Custom colour"
                className="absolute inset-0 cursor-pointer opacity-0"
                value={accent ?? "#c2410c"}
                onChange={event => setAccentDraft(event.target.value.toLowerCase())}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {accent ? <code className="font-mono">{accent}</code> : "Neutral: black in light mode, white in dark mode"}{getPanelAccent() && accent === null ? ", or your panel's accent when opened from it." : "."}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Icon</Label>
          <div className="flex items-center gap-4">
            <SiteMark name={name || site.name} icon={icon?.url ?? site.favicon} className="size-14 rounded-[14px] text-xl" />
            {session.permissions.media.read ? (
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setLibraryOpen(true)}><ImageIcon /> {icon ? "Change" : "Choose"}</Button>
                {icon && <Button type="button" variant="ghost" size="sm" onClick={() => setIcon(null)}>Remove</Button>}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Choosing an icon needs access to the media library.</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            A square image. Also used as the browser tab icon.{!icon && site.favicon && " Until you choose one, the site's own favicon is used."}
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-[16px] elevated p-5">
        <h2 className="text-sm font-medium">Media</h2>
        <label className="flex items-start justify-between gap-4">
          <span className="flex flex-col gap-1">
            <span className="text-sm">Remove location and camera details from photos</span>
            <span className="text-xs text-muted-foreground">
              Uploading a photo that has them asks first, with this as the suggested answer. Uploads from the CLI and agents follow it. Orientation is always kept.
            </span>
          </span>
          <Switch checked={stripMetadata} onCheckedChange={setStripMetadata} />
        </label>
      </section>

      <div className="flex justify-end gap-2">
        {dirty && (
          <Button type="button" variant="ghost" onClick={() => {
            setName(site.name);
            setAccentDraft(site.accent);
            setIcon(site.icon);
            setStripMetadata(site.stripMetadata);
          }}>Discard</Button>
        )}
        <Button type="submit" disabled={!dirty || !name.trim() || save.isPending}>
          {save.isPending ? <Spinner /> : <CheckIcon />} Save
        </Button>
      </div>

      <MediaLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        accept={["image/*"]}
        onSelect={asset => {
          setIcon({ id: asset.id, url: asset.url });
          setLibraryOpen(false);
        }}
      />
    </form>
  );
}

function Swatch({ label, selected, onSelect, className, style }: {
  label: string,
  selected: boolean,
  onSelect(): void,
  className?: string,
  style?: React.CSSProperties
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onSelect}
      style={style}
      className={cn(
        "flex size-8 items-center justify-center rounded-full shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_1px_2px_rgb(0_0_0/0.2)] transition-[scale] duration-150 active:scale-90",
        "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        className
      )}
    >
      {selected && <CheckIcon className="size-4 text-white drop-shadow" />}
    </button>
  );
}
