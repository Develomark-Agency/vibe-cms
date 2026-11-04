import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, CheckIcon, CopyIcon, DownloadIcon, HistoryIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "../admin/components/ui/alert-dialog.tsx";
import { Badge } from "../admin/components/ui/badge.tsx";
import { Button } from "../admin/components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../admin/components/ui/dialog.tsx";
import { Input } from "../admin/components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../admin/components/ui/select.tsx";
import { Spinner } from "../admin/components/ui/spinner.tsx";
import { Switch } from "../admin/components/ui/switch.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../admin/components/ui/tooltip.tsx";
import { Delayed } from "../admin/app/delayed.tsx";
import { cn } from "../admin/lib/utils.ts";
import type { BackupPolicy, BackupRun, BackupSnapshot, PanelBackups, PanelSite } from "./backend.ts";

function bytes(n: number): string {
  if(n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if(n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if(n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

function when(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const hours = Array.from({ length: 24 }, (_, hour) => {
  const local = new Date();
  local.setUTCHours(hour, 0, 0, 0);
  return { value: String(hour), label: `${local.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} (${String(hour).padStart(2, "0")}:00 UTC)` };
});

/** When and how many: shared by the panel's defaults and a site's own policy. */
function PolicyFields({ policy, onChange, disabled }: { policy: BackupPolicy, onChange(next: BackupPolicy): void, disabled?: boolean }) {
  const keep = (key: "keepDaily" | "keepWeekly" | "keepMonthly", label: string) => (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        type="number" min={0} max={1000} value={policy[key]} disabled={disabled || !policy.enabled}
        onChange={e => onChange({ ...policy, [key]: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })}
      />
    </label>
  );
  return (
    <div className="grid gap-3">
      <label className="flex items-center justify-between gap-3 text-sm">
        Back up every day
        <Switch checked={policy.enabled} disabled={disabled} onCheckedChange={enabled => onChange({ ...policy, enabled })} />
      </label>
      <div className={cn("grid gap-3", !policy.enabled && "opacity-50")}>
        <div className="grid gap-1 text-xs text-muted-foreground">
          At
          <Select items={hours} value={String(policy.hour)} onValueChange={value => onChange({ ...policy, hour: Number(value) })} disabled={disabled || !policy.enabled}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{hours.map(h => <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {keep("keepDaily", "Daily, for days")}
          {keep("keepWeekly", "Weekly, for weeks")}
          {keep("keepMonthly", "Monthly, for months")}
        </div>
        <p className="text-xs text-muted-foreground">The last two days are always kept, and so is the snapshot taken before each restore, for 30 days.</p>
      </div>
    </div>
  );
}

function progressText(run: BackupRun): string {
  const verb = run.kind === "restore" ? "Restoring" : "Backing up";
  if(run.status === "queued") return run.retryAt ? `Retrying at ${new Date(run.retryAt).toLocaleTimeString()}` : "Waiting to start";
  const p = run.progress;
  if(!p) return `${verb}…`;
  if(p.step === "table") return `${verb} · ${String(p.table)} ${String(p.rows)}/${String(p.total)}`;
  if(p.step === "file") return `${verb} · files ${String(p.done)}/${String(p.total)}`;
  if(p.step === "commit") return "Restoring · finishing";
  if(p.step === "retry") return `${verb} · retrying after a network error`;
  return `${verb}…`;
}

function TrustNotice({ trusted, panel, trustedPanel }: { trusted: boolean | null, panel: string | null, trustedPanel: string | null }) {
  const [copied, setCopied] = useState(false);
  if(trusted === true) return null;
  if(trusted === null) {
    return <p className="flex gap-2 rounded-[10px] well px-3 py-2 text-sm text-muted-foreground"><TriangleAlertIcon className="mt-0.5 size-4 shrink-0" /> The site can't be reached, so whether it allows backups is unknown.</p>;
  }
  // A site in another org needs its VIBE_ORG changed too, which is a deploy setting, not config.
  const snippet = "backups: true";
  return (
    <div className="grid gap-2 rounded-[10px] border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm">
      <p className="flex gap-2"><ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <span>{trustedPanel ? `This site trusts another org (${trustedPanel}), not ${panel ?? "this one"}: set its VIBE_ORG to ${panel ?? "this hub's org"}, then add this to its` : "This site doesn't let this panel back it up yet. Add this to its"} <code className="font-mono text-xs whitespace-nowrap">vibe-cms.config.ts</code> and deploy:</span>
      </p>
      <div className="flex gap-2">
        <Input readOnly value={snippet} className="font-mono text-xs" onFocus={e => e.currentTarget.select()} aria-label="Config to add" />
        <Button variant="outline" size="sm" onClick={async () => {
          await navigator.clipboard.writeText(snippet);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}>{copied ? <CheckIcon /> : <CopyIcon />}</Button>
      </div>
    </div>
  );
}

/** A site's snapshots, its schedule, and restoring. */
export function BackupsDialog({ backups, site, open, onOpenChange }: { backups: PanelBackups, site: PanelSite | null, open: boolean, onOpenChange(open: boolean): void }) {
  const queryClient = useQueryClient();
  const key = ["backups", site?.id];
  const status = useQuery({
    queryKey: key,
    queryFn: () => backups.site(site!.id),
    enabled: open && site !== null,
    // Follows a run while one is under way.
    refetchInterval: query => (query.state.data?.runs.some(r => r.status === "queued" || r.status === "running") ? 2000 : false)
  });
  const [confirm, setConfirm] = useState<BackupSnapshot | null>(null);
  const [draft, setDraft] = useState<BackupPolicy | null>(null);
  useEffect(() => setDraft(null), [site?.id, open]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const backUp = useMutation({ mutationFn: () => backups.backUp(site!.id), onSuccess: refresh, onError: (error: Error) => toast.error(error.message) });
  const restore = useMutation({
    mutationFn: (snapshot: BackupSnapshot) => backups.restore(site!.id, snapshot.id),
    onSuccess: () => {
      setConfirm(null);
      void refresh();
    },
    onError: (error: Error) => toast.error(error.message)
  });
  const save = useMutation({
    mutationFn: (policy: BackupPolicy | null) => backups.setPolicy(site!.id, policy),
    onSuccess: data => {
      queryClient.setQueryData(key, data);
      setDraft(null);
      toast.success("Schedule saved");
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const data = status.data;
  const active = data?.runs.find(r => r.status === "queued" || r.status === "running");
  const [latest] = data?.runs ?? [];
  const lastDone = data?.snapshots.find(s => s.kind !== "safety");
  const custom = draft ?? data?.policy ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Backups{site && ` · ${site.name}`}</DialogTitle>
          <DialogDescription>
            Snapshots of the site's content and media, kept in this panel's archive. Restoring replaces everything editors can change; code stays as deployed.
          </DialogDescription>
        </DialogHeader>
        {status.isLoading || !data ? (
          <Delayed><div className="flex justify-center p-6"><Spinner /></div></Delayed>
        ) : !data.available ? (
          <p className="rounded-[10px] well px-3 py-2 text-sm text-muted-foreground">This panel has no archive. Bind an R2 bucket as <code className="font-mono text-xs">BACKUPS</code> to back sites up.</p>
        ) : (
          <div className="grid gap-5">
            <TrustNotice trusted={data.trusted} panel={data.panel} trustedPanel={data.trustedPanel} />

            <section className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-medium">{lastDone ? `Last backup ${when(lastDone.takenAt)}` : "Not backed up yet"}</div>
                <div className="text-xs text-muted-foreground">
                  {active ? <span className="inline-flex items-center gap-1.5"><Spinner className="size-3" /> {progressText(active)}</span>
                    : data.trusted === false ? "Backups start once the site allows them"
                      : data.effective.enabled && data.nextAt ? `Next ${when(data.nextAt)}` : "Daily backups are off"}
                </div>
              </div>
              <Button onClick={() => backUp.mutate()} disabled={Boolean(active) || backUp.isPending || data.trusted === false}>
                {backUp.isPending ? <Spinner /> : <ArchiveIcon />} Back up now
              </Button>
            </section>

            {latest?.status === "failed" && (
              <p className="flex gap-2 rounded-[10px] bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                <span><span className="font-medium">{latest.kind === "restore" ? "The restore failed" : "The last backup failed"}</span> ({when(latest.finishedAt ?? latest.createdAt)}, after {latest.attempts} {latest.attempts === 1 ? "try" : "tries"}): {latest.error}
                  {latest.kind === "restore" && " The site wasn't changed."}</span>
              </p>
            )}
            {latest?.status === "done" && latest.kind === "restore" && (
              <p className="flex gap-2 rounded-[10px] well px-3 py-2 text-sm"><CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" /> Restored {when(latest.finishedAt!)}{latest.requestedBy && ` by ${latest.requestedBy}`}.</p>
            )}

            <section className="grid gap-2">
              <h3 className="text-sm font-medium">Snapshots <span className="font-normal text-muted-foreground tabular-nums">{data.snapshots.length}</span></h3>
              {data.snapshots.length ? (
                <ul className="grid gap-1">
                  {data.snapshots.map(snapshot => (
                    <li key={snapshot.id} className="flex items-center gap-3 rounded-[10px] well px-3 py-2">
                      <HistoryIcon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {when(snapshot.takenAt)}
                          {snapshot.kind === "manual" && <Badge variant="outline">Manual</Badge>}
                          {snapshot.kind === "safety" && <Badge variant="secondary">Before a restore</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {snapshot.documents} documents · {snapshot.files} files · {bytes(snapshot.bytes)}
                          {snapshot.warnings.length > 0 && <span title={snapshot.warnings.join("\n")}> · {snapshot.warnings.length} warning{snapshot.warnings.length === 1 ? "" : "s"}</span>}
                        </div>
                      </div>
                      <Tooltip>
                        <TooltipTrigger render={
                          <Button variant="ghost" size="icon-sm" aria-label="Download as a .vibe file" nativeButton={false} render={<a href={backups.downloadUrl(snapshot.id)} download />}><DownloadIcon /></Button>
                        } />
                        <TooltipContent>Download as a .vibe file</TooltipContent>
                      </Tooltip>
                      <Button variant="ghost" size="sm" disabled={Boolean(active) || data.trusted === false} onClick={() => setConfirm(snapshot)}>Restore…</Button>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground">None yet.</p>}
            </section>

            <section className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">Schedule</h3>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Panel defaults
                  <Switch size="sm" checked={custom === null} onCheckedChange={useDefaults => setDraft(useDefaults ? null : { ...data.effective })}
                    disabled={save.isPending} />
                </label>
              </div>
              <PolicyFields policy={custom ?? data.effective} onChange={setDraft} disabled={custom === null} />
              {(draft !== null || (data.policy !== null && custom === null)) && (
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                  <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>{save.isPending && <Spinner />} Save schedule</Button>
                </DialogFooter>
              )}
            </section>
          </div>
        )}
      </DialogContent>

      <AlertDialog open={confirm !== null} onOpenChange={next => !next && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore {site?.name} to {confirm && when(confirm.takenAt)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every document, file and setting editors can change is replaced with the snapshot's. Edits since then are lost from the site,
              but a snapshot of the site as it is now is taken first, so you can go back. The site changes all at once, at the end.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={restore.isPending} onClick={() => confirm && restore.mutate(confirm)}>
              {restore.isPending && <Spinner />} Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

/** The panel's default schedule, which every site without its own follows. */
export function BackupDefaultsDialog({ backups, open, onOpenChange }: { backups: PanelBackups, open: boolean, onOpenChange(open: boolean): void }) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["backups"], queryFn: () => backups.status(), enabled: open });
  const [draft, setDraft] = useState<BackupPolicy | null>(null);
  useEffect(() => setDraft(null), [open]);
  const save = useMutation({
    mutationFn: (policy: BackupPolicy) => backups.setDefaults(policy),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["backups"] });
      toast.success("Defaults saved");
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message)
  });
  const policy = draft ?? status.data?.defaults;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Backup schedule</DialogTitle>
          <DialogDescription>
            The default for every site in this panel. A site can have its own from its Backups.
            {" "}Sites allow backups with <code className="font-mono text-xs">backups: true</code> in their config.
          </DialogDescription>
        </DialogHeader>
        {!status.data || !policy ? <Delayed><div className="flex justify-center p-6"><Spinner /></div></Delayed>
          : !status.data.available ? <p className="text-sm text-muted-foreground">This panel has no archive. Bind an R2 bucket as <code className="font-mono text-xs">BACKUPS</code> to back sites up.</p>
            : <PolicyFields policy={policy} onChange={setDraft} />}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!draft || save.isPending} onClick={() => draft && save.mutate(draft)}>{save.isPending && <Spinner />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
