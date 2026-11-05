import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, ChevronDownIcon, MoreHorizontalIcon, PlusIcon, TriangleAlertIcon, UserPlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PRESETS, describeRules } from "../roles.ts";
import { Badge } from "../admin/components/ui/badge.tsx";
import { Button } from "../admin/components/ui/button.tsx";
import { Checkbox } from "../admin/components/ui/checkbox.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../admin/components/ui/dialog.tsx";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../admin/components/ui/dropdown-menu.tsx";
import { Input } from "../admin/components/ui/input.tsx";
import { Label } from "../admin/components/ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../admin/components/ui/select.tsx";
import { Spinner } from "../admin/components/ui/spinner.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../admin/components/ui/tabs.tsx";
import { Delayed } from "../admin/app/delayed.tsx";
import { editableRules, RoleRulesEditor } from "../admin/app/role-rules.tsx";
import { cn } from "../admin/lib/utils.ts";
import type { HubPermission, PanelBranding, PanelHub, PanelRoleRules, PanelSite, PanelUser, RoleTemplate } from "./backend.ts";
import { go } from "./location.ts";

/**
 * The hosted panel's own administration: its members and hub roles, who manages each site and who has
 * which role there, and templates of roles copied onto new sites.
 */

const PERMISSION_LABELS: Record<HubPermission, { label: string, description: string }> = {
  members: { label: "People", description: "Invite people, change their hub roles, remove them" },
  templates: { label: "Templates", description: "Create, edit and delete templates" },
  addSites: { label: "Add sites", description: "Add sites; whoever adds a site manages it" },
  removeSites: { label: "Remove sites", description: "Remove any site from the panel" }
};

function initials(name: string | null | undefined, email: string | null | undefined): string {
  const source = name?.trim() || email?.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function Person({ name, email, detail, invited }: { name: string | null, email: string | null, detail?: string, invited?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full well text-[11px] font-medium text-muted-foreground">{invited ? "?" : initials(name, email)}</span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{name ?? email ?? "Someone"}</p>
        <p className="truncate text-xs text-muted-foreground">{detail ?? (name ? email : null) ?? ""}</p>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  if(role === "owner") return <Badge>Owner</Badge>;
  if(role === "admin") return <Badge>Admin</Badge>;
  if(role === "member") return <Badge variant="secondary">Member</Badge>;
  return <Badge variant="outline" className="capitalize">{role}</Badge>;
}

function relative(time: number | null): string {
  if(!time) return "";
  const days = Math.round((Date.now() - time) / 86_400_000);
  if(days <= 0) return "today";
  if(days === 1) return "yesterday";
  if(days < 14) return `${days} days ago`;
  return new Date(time).toLocaleDateString();
}

function PageHeader({ title, description, children }: { title: string, description: string, children?: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-2">
        <h1 className="text-3xl font-medium tracking-[-0.03em]">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children && <div className="flex shrink-0 gap-2">{children}</div>}
    </header>
  );
}

function Loading() {
  return <Delayed><div className="flex justify-center p-12"><Spinner /></div></Delayed>;
}

// --- Setup ---------------------------------------------------------------------

/** The first-run card: whoever opens the printed link and signs in becomes the panel's owner. */
export function SetupCard({ branding, signInUrl, token }: { branding: PanelBranding, signInUrl: string, token: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-sidebar p-6">
      <div className="flex w-full max-w-md flex-col gap-5 rounded-[24px] elevated px-8 py-9">
        <span className="flex size-10 items-center justify-center rounded-[12px] raised-brand text-sm font-semibold">{branding.name.charAt(0).toUpperCase()}</span>
        <div className="space-y-2">
          <h1 className="text-xl font-medium tracking-tight">Set up {branding.name}</h1>
          <p className="text-sm text-muted-foreground">Nobody owns this panel yet. Whoever opens the setup link and signs in becomes its owner, and the link stops working.</p>
        </div>
        <Button size="lg" className="w-full" render={<a href={`${signInUrl}?setup=${encodeURIComponent(token)}&return=/`} />} nativeButton={false}>
          Sign in and become the owner
        </Button>
        <p className="text-center text-xs text-muted-foreground">Not you? Close this tab. The link was printed in the panel's logs.</p>
      </div>
    </div>
  );
}

// --- People ---------------------------------------------------------------------

export function PeoplePage({ hub, user }: { hub: PanelHub, user: PanelUser }) {
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: ["members"], queryFn: () => hub.members() });
  const [inviteOpen, setInviteOpen] = useState(false);
  const canManage = user.permissions?.includes("members") ?? false;
  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ["members"] });
  }
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string, role: string }) => hub.setMemberRole(id, role),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message)
  });
  const remove = useMutation({
    mutationFn: (id: string) => hub.removeMember(id),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message)
  });

  useEffect(() => {
    document.title = "People";
  }, []);

  if(data.isError) return <p className="p-12 text-center text-sm text-muted-foreground">{(data.error as Error).message}</p>;
  if(!data.data) return <Loading />;
  const { members, roles, sites, me } = data.data;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-12 md:px-10">
      <PageHeader title="People" description="Who can sign in to the panel, and what they can do here.">
        {canManage && <Button onClick={() => setInviteOpen(true)}><UserPlusIcon /> Invite person</Button>}
      </PageHeader>
      <Tabs defaultValue="members">
        <TabsList variant="line">
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="roles">Hub roles</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="pt-4">
          <div className="overflow-hidden rounded-[16px] elevated">
            <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_3rem] gap-4 border-b px-5 py-3 text-xs text-muted-foreground sm:grid">
              <span>Person</span><span>Hub role</span><span>Sites</span><span />
            </div>
            <ul className="divide-y">
              {members.map(member => {
                const self = member.sub === me.sub;
                const editable = canManage && !self && member.role !== "owner";
                const siteSummary = member.role === "owner" || member.role === "admin"
                  ? `All ${sites} ${sites === 1 ? "site" : "sites"}`
                  : [member.managedSites ? `Manages ${member.managedSites}` : null, member.assignedSites.length ? (member.assignedSites.length > 2 ? `Role on ${member.assignedSites.length}` : member.assignedSites.join(", ")) : null].filter(Boolean).join(" · ") || "No sites";
                return (
                  <li key={member.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_3rem]">
                    <Person name={member.name} email={member.email} invited={member.invited} detail={member.invited ? `Invited ${relative(member.addedAt)}` : undefined} />
                    <div className="sm:order-none">
                      {editable ? (
                        <Select items={roles.filter(r => r.name !== "owner").map(r => ({ value: r.name, label: r.name }))} value={member.role} onValueChange={role => role && setRole.mutate({ id: member.id, role })}>
                          <SelectTrigger size="sm" className="w-40 capitalize"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {roles.filter(r => r.name !== "owner").map(r => <SelectItem key={r.name} value={r.name} className="capitalize">{r.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      ) : <RoleBadge role={member.role} />}
                    </div>
                    <span className="col-span-2 truncate text-sm text-muted-foreground sm:col-span-1">{siteSummary}</span>
                    <div className="hidden justify-end sm:flex">
                      {self ? <span className="text-sm text-muted-foreground">You</span> : editable && (
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${member.email ?? member.name}`}><MoreHorizontalIcon /></Button>} />
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem variant="destructive" onClick={() => {
                              if(confirm(`Remove ${member.email ?? member.name} from the panel? They lose every site role the panel gave them.`)) remove.mutate(member.id);
                            }}>Remove from panel</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">People who aren't listed can still sign in if your identity provider allows them; they only see sites they've been given a role on.</p>
        </TabsContent>
        <TabsContent value="roles" className="pt-4">
          <HubRoles hub={hub} roles={roles} canManage={canManage} />
        </TabsContent>
      </Tabs>
      <InviteDialog hub={hub} roles={roles.filter(r => r.name !== "owner").map(r => r.name)} open={inviteOpen} onOpenChange={setInviteOpen} onDone={refresh} />
    </div>
  );
}

function InviteDialog({ hub, roles, open, onOpenChange, onDone }: { hub: PanelHub, roles: string[], open: boolean, onOpenChange(open: boolean): void, onDone(): void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const invite = useMutation({
    mutationFn: () => hub.invite(email.trim(), role),
    onSuccess() {
      toast.success(`Invited ${email.trim()}`);
      setEmail("");
      onOpenChange(false);
      onDone();
    }
  });
  return (
    <Dialog open={open} onOpenChange={next => {
      onOpenChange(next);
      if(!next) invite.reset();
    }}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={event => {
          event.preventDefault();
          invite.mutate();
        }}>
          <DialogHeader>
            <DialogTitle>Invite a person</DialogTitle>
            <DialogDescription>They join the panel with this role the first time they sign in with this verified email. Send them the panel's address yourself.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" type="email" autoFocus required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@agency.com" />
          </div>
          <div className="grid gap-2">
            <Label>Hub role</Label>
            <Select items={roles.map(r => ({ value: r, label: r }))} value={role} onValueChange={value => value && setRole(value)}>
              <SelectTrigger className="w-full capitalize"><SelectValue /></SelectTrigger>
              <SelectContent>{roles.map(r => <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {invite.isError && <p className="text-sm text-destructive">{(invite.error as Error).message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!email.trim() || invite.isPending}>{invite.isPending && <Spinner />} Invite</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HubRoles({ hub, roles, canManage }: { hub: PanelHub, roles: Array<{ name: string, permissions: HubPermission[], builtIn: boolean }>, canManage: boolean }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const save = useMutation({
    mutationFn: ({ role, permissions }: { role: string, permissions: HubPermission[] }) => hub.saveHubRole(role, permissions),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members"] }),
    onError: (error: Error) => toast.error(error.message)
  });
  const remove = useMutation({
    mutationFn: (role: string) => hub.deleteHubRole(role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members"] }),
    onError: (error: Error) => toast.error(error.message)
  });
  const all = Object.keys(PERMISSION_LABELS) as HubPermission[];
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-[16px] elevated">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="px-5 py-3 text-left font-normal">Role</th>
              {all.map(p => <th key={p} className="px-3 py-3 text-center font-normal" title={PERMISSION_LABELS[p].description}>{PERMISSION_LABELS[p].label}</th>)}
              <th className="w-12" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {roles.map(role => (
              <tr key={role.name}>
                <td className="px-5 py-3">
                  <span className="font-medium capitalize">{role.name}</span>
                  <p className="text-xs text-muted-foreground">
                    {role.name === "owner" ? "Everything; can't be removed by anyone else" : role.name === "admin" ? "Everything but the owner; sees every site" : role.name === "member" ? "Only the sites they're given" : "Custom"}
                  </p>
                </td>
                {all.map(p => (
                  <td key={p} className="px-3 py-3 text-center">
                    <Checkbox
                      aria-label={`${role.name}: ${PERMISSION_LABELS[p].label}`}
                      checked={role.permissions.includes(p)}
                      disabled={role.builtIn || !canManage}
                      onCheckedChange={on => save.mutate({ role: role.name, permissions: on ? [...role.permissions, p] : role.permissions.filter(x => x !== p) })}
                    />
                  </td>
                ))}
                <td className="pr-3 text-right">
                  {!role.builtIn && canManage && (
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${role.name}`} onClick={() => remove.mutate(role.name)}><XIcon /></Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManage && (
        <form className="flex max-w-md gap-2" onSubmit={event => {
          event.preventDefault();
          save.mutate({ role: name.trim(), permissions: [] }, { onSuccess: () => setName("") });
        }}>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Site manager" aria-label="New hub role" />
          <Button type="submit" variant="outline" disabled={!name.trim() || save.isPending}><PlusIcon /> Add role</Button>
        </form>
      )}
    </div>
  );
}

// --- Templates ---------------------------------------------------------------------

const SPECIAL = new Set(["all", "publish", "write", "media", "siteSettings", "backups"]);

export function TemplatesPage({ hub, user }: { hub: PanelHub, user: PanelUser }) {
  const queryClient = useQueryClient();
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => hub.templates() });
  const [selected, setSelected] = useState<string | null>(null);
  const canEdit = user.permissions?.includes("templates") ?? false;
  const create = useMutation({
    mutationFn: () => hub.saveTemplate(null, {
      name: "New template",
      roles: Object.fromEntries(PRESETS.filter(p => p.name !== "translator").map(p => [p.name, p.rules as PanelRoleRules])),
      isDefault: !templates.data?.length
    }),
    async onSuccess(template) {
      await queryClient.invalidateQueries({ queryKey: ["templates"] });
      setSelected(template.id);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  useEffect(() => {
    document.title = "Templates";
  }, []);

  if(!templates.data) return <Loading />;
  const list = templates.data;
  const current = list.find(t => t.id === selected) ?? list[0] ?? null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-12 md:px-10">
      <PageHeader title="Templates" description="Sets of roles you can start a new site with.">
        {canEdit && <Button onClick={() => create.mutate()} disabled={create.isPending}>{create.isPending ? <Spinner /> : <PlusIcon />} New template</Button>}
      </PageHeader>
      {list.length === 0 ? (
        <div className="rounded-[16px] well p-8 text-center text-sm text-muted-foreground">
          No templates yet. New sites start with owners only, and roles are added from the site's editor.
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] md:items-start">
          <nav className="flex flex-col gap-1 rounded-[16px] elevated p-1.5" aria-label="Templates">
            {list.map(template => (
              <button key={template.id} type="button" onClick={() => setSelected(template.id)} aria-current={current?.id === template.id ? "true" : undefined}
                className={cn("flex items-center gap-3 rounded-[12px] px-3 py-2.5 text-left transition-colors hover:bg-accent/60", current?.id === template.id && "bg-accent")}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{template.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {Object.keys(template.roles).length} {Object.keys(template.roles).length === 1 ? "role" : "roles"} · used on {template.usedBy} {template.usedBy === 1 ? "site" : "sites"}
                  </p>
                </div>
                {template.isDefault && <Badge variant="secondary">Default</Badge>}
              </button>
            ))}
          </nav>
          {current && <TemplateEditor key={`${current.id}:${current.updatedAt}`} hub={hub} template={current} canEdit={canEdit} onDeleted={() => setSelected(null)} />}
        </div>
      )}
    </div>
  );
}

function TemplateEditor({ hub, template, canEdit, onDeleted }: { hub: PanelHub, template: RoleTemplate, canEdit: boolean, onDeleted(): void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(template.name);
  const [roles, setRoles] = useState<Record<string, PanelRoleRules>>(template.roles);
  const [editing, setEditing] = useState<string | null>(null);
  const [newRole, setNewRole] = useState("");
  const dirty = name !== template.name || JSON.stringify(roles) !== JSON.stringify(template.roles);
  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ["templates"] });
  }
  const save = useMutation({
    mutationFn: (input: { name?: string, roles?: Record<string, PanelRoleRules>, isDefault?: boolean }) => hub.saveTemplate(template.id, input),
    onSuccess: async () => {
      await refresh();
      toast.success("Template saved");
    },
    onError: (error: Error) => toast.error(error.message)
  });
  const remove = useMutation({
    mutationFn: () => hub.deleteTemplate(template.id),
    onSuccess: async () => {
      await refresh();
      onDeleted();
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <section className="flex flex-col rounded-[16px] elevated">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        {canEdit
          ? <Input value={name} onChange={e => setName(e.target.value)} aria-label="Template name" className="max-w-sm text-base font-medium" />
          : <h2 className="text-lg font-medium">{template.name}</h2>}
        <p className="shrink-0 text-sm text-muted-foreground">Edited {relative(template.updatedAt)}</p>
      </div>
      <p className="mx-5 mt-4 rounded-[10px] well px-3 py-2.5 text-sm text-muted-foreground">
        Templates are copied onto a site when it's added. Editing one later doesn't change sites that already use it.
      </p>
      <ul className="mt-2 divide-y">
        {Object.entries(roles).map(([role, rules]) => (
          <li key={role} className="px-5 py-4">
            <div className="flex items-start gap-4">
              <p className="w-36 shrink-0 font-medium">{role}</p>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-muted-foreground">{describeRules(rules)}</p>
                <RuleChips rules={rules} />
              </div>
              {canEdit && (
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(editing === role ? null : role)}>{editing === role ? "Done" : "Edit"}</Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${role}`} onClick={() => setRoles(({ [role]: _gone, ...rest }) => rest)}><XIcon /></Button>
                </div>
              )}
            </div>
            {editing === role && (
              <div className="mt-4 overflow-hidden rounded-[12px] border">
                <RoleRulesEditor rules={editableRules(rules)} onChange={next => setRoles(previous => ({ ...previous, [role]: next }))} types={null} locales={null} />
              </div>
            )}
          </li>
        ))}
        {Object.keys(roles).length === 0 && <li className="px-5 py-4 text-sm text-muted-foreground">No roles: sites start with owners only.</li>}
      </ul>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <Input value={newRole} onChange={e => setNewRole(e.target.value)} placeholder="client-editor" aria-label="New role name" className="w-48" />
          <Button variant="outline" size="sm" disabled={!/^[a-z][a-z0-9_-]{0,39}$/i.test(newRole.trim()) || newRole.trim() === "owner" || newRole.trim() in roles} onClick={() => {
            setRoles(previous => ({ ...previous, [newRole.trim()]: {} }));
            setEditing(newRole.trim());
            setNewRole("");
          }}><PlusIcon /> Add role</Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm">From preset <ChevronDownIcon /></Button>} />
            <DropdownMenuContent>
              {PRESETS.map(preset => (
                <DropdownMenuItem key={preset.name} onClick={() => setRoles(previous => ({ ...previous, [preset.name in previous ? `${preset.name}-2` : preset.name]: preset.rules as PanelRoleRules }))}>
                  <div className="flex flex-col"><span>{preset.label}</span><span className="text-xs text-muted-foreground">{preset.description}</span></div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className="flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">Types a site doesn't have are skipped and reported when applied.</p>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {!template.isDefault && <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate({ isDefault: true })}>Make default</Button>}
            <Button variant="outline" disabled={remove.isPending} onClick={() => {
              if(confirm(`Delete ${template.name}? Sites that used it keep their roles.`)) remove.mutate();
            }}>Delete</Button>
            <Button disabled={!dirty || save.isPending} onClick={() => save.mutate({ name, roles })}>{save.isPending && <Spinner />} Save template</Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** What a role's rules grant, as small chips. */
function RuleChips({ rules }: { rules: PanelRoleRules }) {
  const chips: React.ReactNode[] = [];
  if(rules.all) return null;
  for(const [key, value] of Object.entries(rules)) {
    if(SPECIAL.has(key) || !Array.isArray(value) || !value.length) continue;
    chips.push(<span key={key} className="inline-flex items-center gap-1.5 rounded-full well px-2.5 py-0.5 text-xs"><code className="font-mono text-muted-foreground">{key === "*" ? "all types" : key}</code>{(value as string[]).join(" ")}</span>);
  }
  if(Array.isArray(rules.media)) chips.push(<span key="media" className="inline-flex items-center gap-1.5 rounded-full well px-2.5 py-0.5 text-xs"><code className="font-mono text-muted-foreground">media</code>{(rules.media as string[]).join(" ") || "none"}</span>);
  if(rules.siteSettings) chips.push(<span key="settings" className="rounded-full well px-2.5 py-0.5 text-xs">Site settings</span>);
  if(rules.backups) chips.push(<span key="backups" className="rounded-full well px-2.5 py-0.5 text-xs">{rules.backups === "take" ? "Takes backups" : "Takes and restores backups"}</span>);
  if(rules.publish === false) chips.push(<span key="publish" className="rounded-full well px-2.5 py-0.5 text-xs text-muted-foreground">Publishing off</span>);
  const locales = (rules.write as { locales?: string[] } | undefined)?.locales;
  if(locales?.length) chips.push(<span key="locales" className="rounded-full well px-2.5 py-0.5 text-xs">Writes in {locales.join(", ")}</span>);
  return chips.length ? <div className="mt-2 flex flex-wrap gap-1.5">{chips}</div> : null;
}

/** The Add site dialog's choice of starting roles: a template, or none. `undefined` is not offered; the default is preselected. */
export function TemplatePicker({ hub, value, onChange }: { hub: PanelHub, value: string | null | undefined, onChange(next: string | null): void }) {
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => hub.templates() });
  const list = templates.data ?? [];
  useEffect(() => {
    if(value === undefined && templates.data) onChange(templates.data.find(t => t.isDefault)?.id ?? null);
  }, [templates.data, value]);
  if(!templates.data) return null;
  const options = [...list.map(t => ({ id: t.id as string | null, name: t.name, detail: Object.keys(t.roles).join(", ") || "No roles", isDefault: t.isDefault })), { id: null, name: "No roles", detail: "Owners only. Add roles later from the site's editor", isDefault: false }];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium">Starting roles</legend>
      {options.map(option => {
        const checked = value === option.id;
        return (
          <label key={option.id ?? "none"} className={cn("flex cursor-pointer items-start gap-3 rounded-[12px] border px-3.5 py-3 transition-colors", checked ? "border-foreground/60 bg-accent/40" : "hover:bg-accent/30")}>
            <input type="radio" name="template" className="mt-1 accent-current" checked={checked} onChange={() => onChange(option.id)} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{option.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{option.detail}</span>
            </span>
            {option.isDefault && <Badge variant="secondary">Default</Badge>}
          </label>
        );
      })}
    </fieldset>
  );
}

// --- A site's access ---------------------------------------------------------------------

export function AccessPage({ hub, siteId, site }: { hub: PanelHub, siteId: string, site: PanelSite | null }) {
  const queryClient = useQueryClient();
  const access = useQuery({ queryKey: ["access", siteId], queryFn: () => hub.siteAccess(siteId) });
  const members = useQuery({ queryKey: ["members"], queryFn: () => hub.members(), enabled: access.data?.me.admin === true, retry: false });
  const [adding, setAdding] = useState(false);
  const [applying, setApplying] = useState(false);
  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ["access", siteId] });
  }
  const assign = useMutation({
    mutationFn: ({ who, roles }: { who: { email?: string, sub?: string }, roles: string[] }) => hub.assign(siteId, who, roles),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message)
  });
  const unassign = useMutation({
    mutationFn: (principal: string) => hub.unassign(siteId, principal),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message)
  });
  const owners = useMutation({
    mutationFn: ({ sub, add }: { sub: string, add: boolean }) => (add ? hub.addOwner(siteId, sub) : hub.removeOwner(siteId, sub)),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message)
  });

  useEffect(() => {
    document.title = `Access · ${site?.name ?? "Site"}`;
  }, [site?.name]);

  if(access.isError) return <p className="p-12 text-center text-sm text-muted-foreground">{(access.error as Error).message}</p>;
  if(!access.data) return <Loading />;
  const data = access.data;
  const roleNames = data.roles?.map(r => r.name) ?? [];
  const candidates = (members.data?.members ?? []).filter(m => m.sub && m.role !== "owner" && m.role !== "admin" && !data.owners.some(o => o.sub === m.sub));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-12 md:px-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <button type="button" onClick={() => go("/")} className="text-sm text-muted-foreground hover:text-foreground">Sites</button>
          <span className="text-sm text-muted-foreground"> / {data.site.name}</span>
          <h1 className="text-3xl font-medium tracking-[-0.03em]">{data.site.name}</h1>
          <p className="text-sm text-muted-foreground">{new URL(data.site.url).host}</p>
        </div>
        <Button variant="outline" onClick={() => go(`/s/${encodeURIComponent(siteId)}/`)}>Open editor</Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="flex flex-col gap-6">
          <section className="rounded-[16px] elevated">
            <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
              <h2 className="font-medium">Site owners</h2>
              <p className="text-sm text-muted-foreground">Can edit this site's roles and people</p>
            </div>
            <ul className="divide-y">
              {data.owners.map(owner => (
                <li key={owner.sub} className="flex items-center justify-between gap-3 px-5 py-3">
                  <Person name={owner.name} email={owner.email} detail={owner.kind === "owner" ? "Panel owner" : owner.kind === "admin" ? "Panel admin" : owner.adder ? `Added the site${owner.grantedAt ? ` · ${new Date(owner.grantedAt).toLocaleDateString()}` : ""}` : "Site owner"} />
                  {owner.kind === "grant"
                    ? data.me.admin
                      ? <Button variant="ghost" size="sm" onClick={() => owners.mutate({ sub: owner.sub, add: false })}>Remove</Button>
                      : <Badge variant="secondary">Owner</Badge>
                    : <Badge>Always</Badge>}
                </li>
              ))}
            </ul>
            {data.me.admin && candidates.length > 0 && (
              <div className="border-t px-5 py-3">
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="outline" size="sm"><PlusIcon /> Add site owner</Button>} />
                  <DropdownMenuContent align="start" className="w-64">
                    {candidates.map(m => <DropdownMenuItem key={m.id} onClick={() => owners.mutate({ sub: m.sub!, add: true })}>{m.name ?? m.email}</DropdownMenuItem>)}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </section>

          <section className="rounded-[16px] elevated">
            <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
              <h2 className="font-medium">People with a role</h2>
              {data.canManage && <Button size="sm" disabled={!data.roles?.length} onClick={() => setAdding(true)}><UserPlusIcon /> Add person</Button>}
            </div>
            {data.people.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">Nobody yet. {data.canManage ? (data.roles?.length ? "Add someone to give them a role here." : "The site has no roles yet: add some in its editor first.") : ""}</p>}
            <ul className="divide-y">
              {data.people.map(person => (
                <li key={person.principal} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <Person name={person.name} email={person.email} detail={person.invited ? `${person.email} · hasn't signed in yet` : undefined} />
                  <div className="flex items-center gap-1">
                    {data.canManage ? (
                      <RolesMenu roles={roleNames} value={person.roles} onChange={roles => assign.mutate({ who: person.invited ? { email: person.email! } : { sub: person.principal }, roles })} />
                    ) : person.roles.map(role => <Badge key={role} variant="secondary">{role}</Badge>)}
                    {data.canManage && <Button variant="ghost" size="icon-sm" aria-label={`Remove ${person.email ?? person.name}`} onClick={() => unassign.mutate(person.principal)}><XIcon /></Button>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="flex flex-col gap-4">
          <section className="flex flex-col gap-2 rounded-[16px] elevated p-5">
            <h2 className="font-medium">Roles</h2>
            <p className="text-sm text-muted-foreground">Defined on the site, so changes apply the moment they're saved. The pickers list the site's own roles.</p>
            {data.rolesError && <p className="text-sm text-destructive">{data.rolesError}</p>}
            {data.roles && (
              <ul className="flex flex-col gap-1 py-1">
                {data.roles.map(role => (
                  <li key={role.name} className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{role.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{describeRules(role.rules)}</span>
                    {role.stale.length > 0 && <TriangleAlertIcon className="size-3.5 shrink-0 text-amber-600" aria-label="Has rules for missing types" />}
                  </li>
                ))}
              </ul>
            )}
            {data.canManage && (
              <button type="button" className="flex items-center gap-1 self-start text-sm font-medium text-primary hover:underline" onClick={() => go(`/s/${encodeURIComponent(siteId)}/roles`)}>
                Edit roles in the site editor <ArrowRightIcon className="size-3.5" />
              </button>
            )}
          </section>

          <section className="flex flex-col gap-2 rounded-[16px] elevated p-5">
            <h2 className="font-medium">Starting template</h2>
            {data.template ? (
              <>
                <p className="text-sm text-muted-foreground">{data.template.name ?? "A deleted template"}</p>
                <p className="flex items-center gap-2 text-sm">
                  <span className={cn("size-2 rounded-full", data.template.state === "applied" ? "bg-emerald-500" : data.template.state === "pending" ? "bg-amber-500" : "bg-destructive")} />
                  {data.template.state === "applied" ? "Applied" : data.template.state === "pending" ? `Waiting for the site (try ${data.template.attempts})` : "Failed"}
                </p>
                {data.template.error && data.template.state !== "applied" && <p className="text-xs text-muted-foreground">{data.template.error}</p>}
                {data.template.skipped.length > 0 && (
                  <div className="rounded-[10px] bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                    {data.template.skipped.length} {data.template.skipped.length === 1 ? "rule" : "rules"} skipped: {data.template.skipped.join("; ")}
                  </div>
                )}
              </>
            ) : <p className="text-sm text-muted-foreground">None: the site started with owners only.</p>}
            {data.canManage && <button type="button" className="self-start text-sm font-medium text-primary hover:underline" onClick={() => setApplying(true)}>{data.template ? "Re-apply a template…" : "Apply a template…"}</button>}
          </section>
        </aside>
      </div>

      <AddPersonDialog open={adding} onOpenChange={setAdding} roles={roleNames} pending={assign.isPending}
        onAdd={(email, roles) => assign.mutate({ who: { email }, roles }, { onSuccess: () => setAdding(false) })} />
      {data.canManage && <ApplyTemplateDialog hub={hub} siteId={siteId} current={data.roles ?? []} open={applying} onOpenChange={setApplying} onApplied={refresh} />}
    </div>
  );
}

function RolesMenu({ roles, value, onChange }: { roles: string[], value: string[], onChange(next: string[]): void }) {
  const unknown = value.filter(role => !roles.includes(role));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="outline" size="sm" className="min-w-40 justify-between">
          <span className="truncate">{value.length ? value.join(", ") : "No role"}</span>
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      } />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Roles on this site</DropdownMenuLabel>
        {roles.map(role => (
          <DropdownMenuCheckboxItem key={role} checked={value.includes(role)} onCheckedChange={on => onChange(on ? [...value, role] : value.filter(r => r !== role))}>{role}</DropdownMenuCheckboxItem>
        ))}
        {unknown.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Not on the site any more, so ignored:</DropdownMenuLabel>
            {unknown.map(role => <DropdownMenuCheckboxItem key={role} checked onCheckedChange={() => onChange(value.filter(r => r !== role))}>{role}</DropdownMenuCheckboxItem>)}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddPersonDialog({ open, onOpenChange, roles, pending, onAdd }: { open: boolean, onOpenChange(open: boolean): void, roles: string[], pending: boolean, onAdd(email: string, roles: string[]): void }) {
  const [email, setEmail] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => {
    if(open) {
      setEmail("");
      setChosen(roles.slice(0, 1));
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={event => {
          event.preventDefault();
          onAdd(email.trim(), chosen);
        }}>
          <DialogHeader>
            <DialogTitle>Add a person</DialogTitle>
            <DialogDescription>They get these roles on this site the next time they sign in to the panel with this verified email. Your identity provider still has to let them in.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="person-email">Email</Label>
            <Input id="person-email" type="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="name@client.com" />
          </div>
          <div className="grid gap-2">
            <Label>Roles</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {roles.map(role => (
                <label key={role} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={chosen.includes(role)} onCheckedChange={on => setChosen(on ? [...chosen, role] : chosen.filter(r => r !== role))} />
                  {role}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!email.trim() || !chosen.length || pending}>{pending && <Spinner />} Add person</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Re-applying is explicit: it shows what would change against the site's roles, and asks before overwriting. */
function ApplyTemplateDialog({ hub, siteId, current, open, onOpenChange, onApplied }: {
  hub: PanelHub,
  siteId: string,
  current: Array<{ name: string, rules: PanelRoleRules }>,
  open: boolean,
  onOpenChange(open: boolean): void,
  onApplied(): void
}) {
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => hub.templates(), enabled: open });
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const template = templates.data?.find(t => t.id === templateId) ?? templates.data?.[0] ?? null;
  const diff = useMemo(() => {
    if(!template) return null;
    const existing = new Map(current.map(role => [role.name, JSON.stringify(role.rules)]));
    const names = Object.keys(template.roles);
    return {
      added: names.filter(name => !existing.has(name)),
      changed: names.filter(name => existing.has(name) && existing.get(name) !== JSON.stringify(template.roles[name])),
      removed: current.map(role => role.name).filter(name => !names.includes(name))
    };
  }, [template, current]);
  const apply = useMutation({
    mutationFn: () => hub.applyTemplate(siteId, template!.id, replace),
    onSuccess(result) {
      if(result.state === "applied") toast.success(result.skipped.length ? `Applied; skipped ${result.skipped.length}` : "Template applied");
      else toast.error(result.error ?? "The site couldn't be reached");
      onApplied();
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message)
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply a template</DialogTitle>
          <DialogDescription>Writes the template's roles onto the site. Roles with the same name are overwritten.</DialogDescription>
        </DialogHeader>
        {!templates.data ? <Loading /> : templates.data.length === 0 ? <p className="text-sm text-muted-foreground">There are no templates yet.</p> : (
          <div className="grid gap-4">
            <Select items={templates.data.map(t => ({ value: t.id, label: t.name }))} value={template?.id ?? null} onValueChange={value => setTemplateId(value as string)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{templates.data.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
            </Select>
            {diff && (
              <ul className="grid gap-1 text-sm">
                {diff.added.map(name => <li key={name}><span className="text-emerald-600">Adds</span> {name}</li>)}
                {diff.changed.map(name => <li key={name}><span className="text-amber-600">Overwrites</span> {name}</li>)}
                {diff.removed.map(name => <li key={name} className={cn(!replace && "text-muted-foreground")}>{replace ? <span className="text-destructive">Removes</span> : "Keeps"} {name}</li>)}
                {!diff.added.length && !diff.changed.length && (!replace || !diff.removed.length) && <li className="text-muted-foreground">No changes.</li>}
              </ul>
            )}
            {diff && diff.removed.length > 0 && (
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={replace} onCheckedChange={on => setReplace(on)} /> Remove the site's roles that aren't in the template</label>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!template || apply.isPending} onClick={() => apply.mutate()}>{apply.isPending && <Spinner />} Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
