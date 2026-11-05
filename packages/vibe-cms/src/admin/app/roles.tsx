import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, MoreHorizontalIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { RoleRules } from "../../config.ts";
import { describeRules, validRoleName } from "../../roles.ts";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { cn } from "../lib/utils.ts";
import { read, siteApi } from "./client.ts";
import { collectionLabel, useAdmin } from "./context.tsx";
import { editableRules, RoleRulesEditor } from "./role-rules.tsx";

/**
 * The site's roles, stored in its database. Owners and roles with `all` edit them; everyone else who
 * signs in sees them read only. Presets are copied in, with no link back.
 */

function relative(time: number | null): string {
  if(!time) return "";
  const days = Math.round((Date.now() - time) / 86_400_000);
  if(days <= 0) return "today";
  if(days === 1) return "yesterday";
  if(days < 30) return `${days} days ago`;
  return new Date(time).toLocaleDateString();
}

export function RolesPage() {
  const { info } = useAdmin();
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: async () => read(await siteApi(info.prefix).roles.$get()) });
  const presets = useQuery({ queryKey: ["roles", "presets"], queryFn: async () => read(await siteApi(info.prefix).roles.presets.$get()) });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ name: string, rules: RoleRules, title: string } | null>(null);

  useEffect(() => {
    document.title = `Roles · ${info.site.name}`;
  }, [info.site.name]);

  const list = roles.data?.roles ?? [];
  const current = list.find(role => role.name === selected) ?? (selected === "owner" ? null : list[0]) ?? null;
  const showOwner = selected === "owner" || (!current && list.length === 0);
  const canEdit = roles.data?.canEdit ?? false;

  const create = useMutation({
    mutationFn: async ({ name, rules }: { name: string, rules: RoleRules }) => read(await siteApi(info.prefix).roles[":name"].$put({ param: { name }, json: { rules } })),
    async onSuccess(result) {
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      setSelected(result.role.name);
      setCreating(null);
      toast.success(`Added ${result.role.name}`);
    },
    onError: error => toast.error((error as Error).message)
  });

  if(!roles.data) return <div className="flex justify-center p-12"><Spinner className="size-5" /></div>;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-8">
      <header className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-medium tracking-[-0.03em]">Roles</h1>
          <p className="text-sm text-muted-foreground">What each role can do on {info.site.name}. Stored on this site{info.signIn === "hub" ? "; your org's panel gives people these roles" : ""}.</p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline">Add from preset <ChevronDownIcon /></Button>} />
              <DropdownMenuContent align="end" className="w-72">
                {(presets.data?.presets ?? []).map(preset => (
                  <DropdownMenuItem key={preset.name} onClick={() => setCreating({ name: list.some(role => role.name === preset.name) ? `${preset.name}-2` : preset.name, rules: preset.rules as RoleRules, title: `Add ${preset.label}` })}>
                    <div className="flex flex-col">
                      <span>{preset.label}</span>
                      <span className="text-xs text-muted-foreground">{preset.description}</span>
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => setCreating({ name: "", rules: {}, title: "New role" })}><PlusIcon /> New role</Button>
          </div>
        )}
      </header>

      <div className="grid gap-6 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] md:items-start">
        {/* Stays in view beside a long role, scrolling on its own when there are many roles. */}
        <nav className="flex flex-col gap-1 rounded-[16px] elevated p-1.5 md:sticky md:top-4 md:max-h-[calc(100dvh-8rem)] md:overflow-y-auto" aria-label="Roles">
          <RoleListItem active={showOwner} title="Owner" description="Everything, plus users and roles" badge="Built in" onClick={() => setSelected("owner")} />
          <div className="mx-3 my-1 border-t" />
          {list.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No roles yet. {canEdit ? "Start from a preset." : ""}</p>}
          {list.map(role => (
            <RoleListItem
              key={role.name}
              active={!showOwner && current?.name === role.name}
              title={role.name}
              description={describeRules(role.rules)}
              warning={role.stale.length > 0}
              onClick={() => setSelected(role.name)}
            />
          ))}
        </nav>

        {showOwner || !current
          ? <OwnerCard hub={info.signIn === "hub"} />
          : <RoleEditor key={`${current.name}:${current.updatedAt}`} role={current} canEdit={canEdit} onDeleted={() => setSelected(null)} />}
      </div>

      <CreateDialog
        draft={creating}
        taken={list.map(role => role.name)}
        pending={create.isPending}
        onClose={() => setCreating(null)}
        onCreate={(name, rules) => create.mutate({ name, rules })}
      />
    </div>
  );
}

function RoleListItem({ active, title, description, badge, warning, onClick }: { active: boolean, title: string, description: string, badge?: string, warning?: boolean, onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn("flex items-center gap-3 rounded-[12px] px-3 py-2.5 text-left transition-colors hover:bg-accent/60", active && "bg-accent")}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
      {warning && <TriangleAlertIcon className="size-4 shrink-0 text-amber-600" aria-label="Has rules for missing types" />}
      {badge && <Badge variant="secondary">{badge}</Badge>}
    </button>
  );
}

function OwnerCard({ hub }: { hub: boolean }) {
  return (
    <section className="flex flex-col gap-2 rounded-[16px] elevated p-5">
      <h2 className="text-lg font-medium">Owner</h2>
      <p className="text-sm text-muted-foreground">
        Owners can do everything: edit and publish all content, manage media, site settings and backups, and change roles and who may sign in.
        It's built in and can't be edited or removed.
      </p>
      <p className="text-sm text-muted-foreground">
        {hub
          ? "Your org's panel makes its owner and admins, and whoever added this site, owners here."
          : "Give it to people on the Users page."}
      </p>
    </section>
  );
}

interface RoleView {
  name: string,
  rules: RoleRules,
  updatedBy: string | null,
  updatedAt: number | null,
  stale: string[]
}

function RoleEditor({ role, canEdit, onDeleted }: { role: RoleView, canEdit: boolean, onDeleted(): void }) {
  const { info, config } = useAdmin();
  const queryClient = useQueryClient();
  const [rules, setRules] = useState<RoleRules>(() => editableRules(role.rules));
  const dirty = JSON.stringify(rules) !== JSON.stringify(editableRules(role.rules));
  const locales = [...(config.locales ?? [])];
  const readOnly = !canEdit;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: async (next: RoleRules) => read(await siteApi(info.prefix).roles[":name"].$put({ param: { name: role.name }, json: { rules: next } })),
    async onSuccess() {
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      toast.success("Role saved");
    },
    onError: error => toast.error((error as Error).message)
  });
  const remove = useMutation({
    mutationFn: async () => read(await siteApi(info.prefix).roles[":name"].$delete({ param: { name: role.name } })),
    async onSuccess() {
      setConfirmDelete(false);
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      onDeleted();
      toast.success(`Deleted ${role.name}`);
    },
    onError: error => toast.error((error as Error).message)
  });

  const types = Object.keys(config.schemas).map(name => ({ name, label: collectionLabel(config, name, false) }));

  return (
    <section className="flex flex-col rounded-[16px] elevated">
      {/* The role's actions stay in reach on a long role, and say when there's something to save. */}
      {/* The name keeps at least 12rem; when it and the actions don't fit on one line, the actions wrap under it. */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-t-[16px] border-b bg-card/90 px-5 py-3 backdrop-blur-md">
        <div className="flex min-w-0 grow basis-48 items-center gap-2">
          <h2 className="min-w-0 truncate text-lg font-medium" title={role.name}>{role.name}</h2>
          {readOnly && <Badge variant="secondary">Read only</Badge>}
        </div>
        {canEdit && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {dirty && (
              <span className="mr-1 flex items-center gap-1.5 text-sm whitespace-nowrap text-amber-700 dark:text-amber-400" role="status">
                <span className="size-1.5 rounded-full bg-current" /> Unsaved changes
              </span>
            )}
            {dirty && <Button variant="ghost" size="sm" onClick={() => setRules(editableRules(role.rules))}>Discard</Button>}
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(rules)}>{save.isPending && <Spinner />} Save changes</Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More actions for this role"><MoreHorizontalIcon /></Button>} />
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2Icon /> Delete role…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {role.stale.length > 0 && (
        <div className="mx-5 mt-4 flex items-start justify-between gap-3 rounded-[10px] bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <p>
            {role.stale.length} {role.stale.length === 1 ? "rule is" : "rules are"} ignored: {role.stale.map(key => <code key={key} className="font-mono font-medium">{key} </code>)}
            no longer {role.stale.length === 1 ? "exists" : "exist"} on this site.
          </p>
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => setRules(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !role.stale.includes(key))) as RoleRules)}>Remove</Button>
          )}
        </div>
      )}

      <RoleRulesEditor rules={rules} onChange={setRules} types={types} locales={locales} readOnly={readOnly} />

      {role.updatedBy && (
        <p className="border-t px-5 py-4 text-sm text-muted-foreground">
          Edited by {role.updatedBy === "config" ? "the site's config" : role.updatedBy}, {relative(role.updatedAt)}
        </p>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {role.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              People whose only role is {role.name} lose access to the site. Anyone given it by {info.signIn === "hub" ? "your org's panel" : "the Users page"} keeps the name, but it gives them nothing until a role with that name exists again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending && <Spinner />} Delete role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CreateDialog({ draft, taken, pending, onClose, onCreate }: {
  draft: { name: string, rules: RoleRules, title: string } | null,
  taken: string[],
  pending: boolean,
  onClose(): void,
  onCreate(name: string, rules: RoleRules): void
}) {
  const [name, setName] = useState("");
  useEffect(() => setName(draft?.name ?? ""), [draft]);
  const trimmed = name.trim();
  const problem = !trimmed ? null : taken.includes(trimmed) ? "There's already a role with this name" : validRoleName(trimmed);
  return (
    <Dialog open={draft !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <form onSubmit={event => {
          event.preventDefault();
          if(trimmed && !problem && draft) onCreate(trimmed, draft.rules);
        }} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{draft?.title}</DialogTitle>
            <DialogDescription>The role is copied onto this site; edit its rules after adding it.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="role-name">Name</Label>
            <Input id="role-name" autoFocus value={name} placeholder="client-editor" onChange={event => setName(event.target.value)} aria-invalid={Boolean(problem)} />
            {problem && <p className="text-xs text-destructive">{problem}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!trimmed || Boolean(problem) || pending}>{pending && <Spinner />} Add role</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
