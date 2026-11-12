import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, MailIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { read, siteApi } from "./client.ts";
import { useAdmin } from "./context.tsx";
import { Page, PageHeader } from "./page.tsx";
import { callHub } from "./session.ts";
import { askConfirm } from "./confirm.tsx";
import { SitePeople, type SitePeopleData } from "./site-people.tsx";

/**
 * Who may sign in to a site without an org, and with which roles. Owners invite people by email;
 * the invite is emailed when the site can send email, and shown to copy either way.
 */

interface Invited {
  user: { email: string },
  link: string,
  emailed: boolean,
  emailError: string | null,
  expiresAt: number | null
}

export function UsersPage() {
  const { info, session } = useAdmin();
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: async () => read(await siteApi(info.prefix).users.$get()) });
  const [invited, setInvited] = useState<Invited | null>(null);

  useEffect(() => {
    document.title = `Users · ${info.site.name}`;
  }, [info.site.name]);

  const inviteMutation = useMutation({
    mutationFn: async (input: { email: string, roles: string[] }) => read(await siteApi(info.prefix).users.invites.$post({ json: input })),
    onSuccess(result) {
      setInvited(result);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: error => toast.error((error as Error).message)
  });
  const update = useMutation({
    mutationFn: async ({ id, roles }: { id: string, roles: string[] }) => read(await siteApi(info.prefix).users[":id"].$patch({ param: { id }, json: { roles } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
    onError: error => toast.error((error as Error).message)
  });
  const remove = useMutation({
    mutationFn: async (id: string) => read(await siteApi(info.prefix).users[":id"].$delete({ param: { id } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
    onError: error => toast.error((error as Error).message)
  });

  if(!users.data) return <div className="flex justify-center p-12"><Spinner className="size-5" /></div>;
  const { roles, mode, assignable } = users.data;
  const passkeys = mode === "passkey";
  if(mode === "hub") return <HubUsers />;

  return (
    <Page>
      <PageHeader
        eyebrow="Access"
        title="Users"
        summary={passkeys
          ? "People sign in with a passkey they create from their invite. To add a device or replace a lost passkey, invite them again."
          : "People sign in with your identity provider. Roles here are matched to their verified email."}
      />

      <InviteForm roles={roles} assignable={assignable} pending={inviteMutation.isPending} onInvite={input => inviteMutation.mutate(input)} />
      {invited && <InviteResult invited={invited} passkeys={passkeys} onClose={() => setInvited(null)} />}

      <section className="flex flex-col divide-y rounded-[16px] elevated">
        {users.data.users.length === 0 && <p className="p-4 text-sm text-muted-foreground">Nobody yet. Invite someone above.</p>}
        {users.data.users.map(user => (
          <div key={user.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name ?? user.email}{user.email === session.user.email && <span className="text-muted-foreground"> (you)</span>}</p>
              <p className="truncate text-xs text-muted-foreground">
                {user.name && `${user.email} · `}
                {user.lastSignInAt ? `Last signed in ${new Date(user.lastSignInAt).toLocaleDateString()}` : "Hasn't signed in yet"}
                {passkeys && ` · ${user.passkeys} ${user.passkeys === 1 ? "passkey" : "passkeys"}`}
              </p>
            </div>
            <RolePicker roles={roles} assignable={assignable} value={user.roles} disabled={update.isPending || user.roles.some(role => !assignable.includes(role))} onChange={next => update.mutate({ id: user.id, roles: next })} />
            <div className="flex gap-1">
              {passkeys && (
                <Button variant="ghost" size="sm" title="Send a new invite link" onClick={() => inviteMutation.mutate({ email: user.email, roles: user.roles })}>
                  <MailIcon /> Re-invite
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${user.email}`} onClick={async () => {
                if(await askConfirm({ title: `Remove ${user.email}?`, description: "They won't be able to sign in any more. Their passkeys are deleted too.", action: "Remove", destructive: true })) remove.mutate(user.id);
              }}><Trash2Icon /></Button>
            </div>
          </div>
        ))}
      </section>
    </Page>
  );
}

/**
 * Org sites: the hub decides who has which role here. The editor runs inside the panel, so it asks
 * the panel for the list, and for changes, with the signed-in person's own rights on the hub.
 */
function HubUsers() {
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: ["hub-people"], queryFn: () => callHub<SitePeopleData>({ call: "people" }) });
  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ["hub-people"] });
  }
  const assign = useMutation({
    mutationFn: ({ who, roles }: { who: { email?: string, sub?: string }, roles: string[] }) => callHub({ call: "assign", who, roles }),
    onSuccess: refresh,
    onError: error => toast.error((error as Error).message)
  });
  const unassign = useMutation({
    mutationFn: (principal: string) => callHub({ call: "unassign", principal }),
    onSuccess: refresh,
    onError: error => toast.error((error as Error).message)
  });
  return (
    <Page>
      <PageHeader
        eyebrow="Access"
        title="Users"
        summary="People sign in through your org's panel. These are the roles it gives them on this site; changes apply from their next sign-in, within about 10 minutes."
      />
      {people.isError && <p className="text-sm text-destructive">{(people.error as Error).message}</p>}
      {!people.data && !people.isError && <div className="flex justify-center p-12"><Spinner className="size-5" /></div>}
      {people.data && (
        <SitePeople
          data={people.data}
          pending={assign.isPending || unassign.isPending}
          onAssign={(who, roles) => assign.mutateAsync({ who, roles })}
          onUnassign={principal => unassign.mutateAsync(principal)}
        />
      )}
    </Page>
  );
}

/** `assignable`: the roles this person may give out; the others show but can't be changed. */
function RolePicker({ roles, assignable, value, disabled, onChange }: { roles: string[], assignable: string[], value: string[], disabled?: boolean, onChange(next: string[]): void }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {roles.map(role => (
        <label key={role} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value.includes(role)}
            disabled={disabled || !assignable.includes(role)}
            onCheckedChange={checked => onChange(checked ? [...value, role] : value.filter(r => r !== role))}
          />
          {role}
        </label>
      ))}
    </div>
  );
}

function InviteForm({ roles, assignable, pending, onInvite }: { roles: string[], assignable: string[], pending: boolean, onInvite(input: { email: string, roles: string[] }): void }) {
  const [email, setEmail] = useState("");
  const [chosen, setChosen] = useState<string[]>(assignable.filter(role => role !== "owner").slice(0, 1));
  return (
    <form
      className="flex flex-col gap-4 rounded-[16px] elevated p-5"
      onSubmit={event => {
        event.preventDefault();
        onInvite({ email: email.trim(), roles: chosen });
        setEmail("");
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="invite-email">Invite someone</Label>
        <div className="flex gap-2">
          <Input id="invite-email" type="email" required placeholder="name@example.com" value={email} onChange={event => setEmail(event.target.value)} />
          <Button type="submit" disabled={pending || !email.trim() || chosen.length === 0}>{pending ? <Spinner /> : <UserPlusIcon />} Invite</Button>
        </div>
      </div>
      <RolePicker roles={roles} assignable={assignable} value={chosen} onChange={setChosen} />
    </form>
  );
}

function InviteResult({ invited, passkeys, onClose }: { invited: Invited, passkeys: boolean, onClose(): void }) {
  const [copied, setCopied] = useState(false);
  const sentence = invited.emailed
    ? `We emailed ${invited.user.email} a link. You can also send it yourself:`
    : invited.emailError
      ? `The email to ${invited.user.email} couldn't be sent (${invited.emailError}). Send them this link yourself:`
      : `This site can't send email, so send ${invited.user.email} this link yourself:`;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-[16px] border border-primary/30 bg-primary/5 p-4 text-sm">
      <p>{sentence}</p>
      <div className="flex gap-2">
        <Input readOnly value={invited.link} className="font-mono text-xs" onFocus={event => event.currentTarget.select()} aria-label="Invite link" />
        <Button type="button" variant="outline" onClick={async () => {
          await navigator.clipboard.writeText(invited.link);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}>{copied ? <CheckIcon /> : <CopyIcon />} Copy</Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{passkeys && invited.expiresAt ? `It works once, until ${new Date(invited.expiresAt).toLocaleDateString()}.` : "They sign in with your identity provider."}</p>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}
