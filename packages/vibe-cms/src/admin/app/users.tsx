import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, MailIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { read, siteApi } from "./client.ts";
import { useAdmin } from "./context.tsx";

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
  const { roles, mode } = users.data;
  const passkeys = mode === "passkey";
  if(mode === "hub") return <HubUsers users={users.data.hubUsers} />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 md:px-8">
      <header className="space-y-2 pt-6">
        <h1 className="text-3xl font-medium tracking-[-0.03em]">Users</h1>
        <p className="text-sm text-muted-foreground">
          {passkeys
            ? "People sign in with a passkey they create from their invite. To add a device or replace a lost passkey, invite them again."
            : "People sign in with your identity provider. Roles here are matched to their verified email."}
        </p>
      </header>

      <InviteForm roles={roles} pending={inviteMutation.isPending} onInvite={input => inviteMutation.mutate(input)} />
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
            <RolePicker roles={roles} value={user.roles} disabled={update.isPending} onChange={next => update.mutate({ id: user.id, roles: next })} />
            <div className="flex gap-1">
              {passkeys && (
                <Button variant="ghost" size="sm" title="Send a new invite link" onClick={() => inviteMutation.mutate({ email: user.email, roles: user.roles })}>
                  <MailIcon /> Re-invite
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${user.email}`} onClick={() => {
                if(confirm(`Remove ${user.email}? They won't be able to sign in any more.`)) remove.mutate(user.id);
              }}><Trash2Icon /></Button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

/** Org sites: the hub decides who has which role here. The site only shows who it has seen. */
function HubUsers({ users }: { users: Array<{ sub: string, email: string | null, name: string | null, roles: string[], siteAdmin: boolean, lastSignInAt: number }> }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 md:px-8">
      <header className="space-y-2 pt-6">
        <h1 className="text-3xl font-medium tracking-[-0.03em]">Users</h1>
        <p className="text-sm text-muted-foreground">
          Your org's panel decides who can sign in here and with which roles. These are the people it has signed in. To change someone's roles, use the panel's Access tab for this site.
        </p>
      </header>
      <section className="flex flex-col divide-y rounded-[16px] elevated">
        {users.length === 0 && <p className="p-4 text-sm text-muted-foreground">Nobody has signed in through the panel yet.</p>}
        {users.map(user => (
          <div key={user.sub} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name ?? user.email ?? user.sub}</p>
              <p className="truncate text-xs text-muted-foreground">
                {user.name && user.email && `${user.email} · `}Last signed in {new Date(user.lastSignInAt).toLocaleDateString()}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {user.siteAdmin && <Badge>Owner</Badge>}
              {user.roles.map(role => <Badge key={role} variant="secondary">{role}</Badge>)}
              {!user.siteAdmin && user.roles.length === 0 && <span className="text-xs text-muted-foreground">No roles</span>}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function RolePicker({ roles, value, disabled, onChange }: { roles: string[], value: string[], disabled?: boolean, onChange(next: string[]): void }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {roles.map(role => (
        <label key={role} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value.includes(role)}
            disabled={disabled}
            onCheckedChange={checked => onChange(checked ? [...value, role] : value.filter(r => r !== role))}
          />
          {role}
        </label>
      ))}
    </div>
  );
}

function InviteForm({ roles, pending, onInvite }: { roles: string[], pending: boolean, onInvite(input: { email: string, roles: string[] }): void }) {
  const [email, setEmail] = useState("");
  const [chosen, setChosen] = useState<string[]>(roles.filter(role => role !== "owner").slice(0, 1));
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
      <RolePicker roles={roles} value={chosen} onChange={setChosen} />
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
