import { ChevronDownIcon, UserPlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import { Spinner } from "../components/ui/spinner.tsx";

/**
 * Who has which role on an org site, as the hub assigns them. Shown on the site's page in the hub,
 * and on the site editor's Users page, which asks the panel it runs in for the same data.
 */

export interface SitePerson {
  /** A `sub`, or `email:<address>` for someone who hasn't signed in yet. */
  principal: string,
  email: string | null,
  name: string | null,
  invited: boolean,
  roles: string[]
}

export interface SitePeopleData {
  people: SitePerson[],
  /** The site's role names. */
  roles: string[],
  /** Whether this person may give people roles here, and which. */
  canAssign: boolean,
  assignable: string[]
}

function initials(name: string | null | undefined, email: string | null | undefined): string {
  const source = name?.trim() || email?.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function Person({ name, email, detail, invited }: { name: string | null, email: string | null, detail?: string, invited?: boolean }) {
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

export function SitePeople({ data, pending, onAssign, onUnassign, emptyHint }: {
  data: SitePeopleData,
  pending: boolean,
  onAssign(who: { email?: string, sub?: string }, roles: string[]): Promise<unknown>,
  onUnassign(principal: string): Promise<unknown>,
  /** Shown when nobody has a role yet. */
  emptyHint?: string
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SitePerson | null>(null);
  function who(person: SitePerson) {
    return person.invited ? { email: person.email! } : { sub: person.principal };
  }
  // People holding roles beyond this person's reach show read only.
  function changeable(person: SitePerson) {
    return data.canAssign && person.roles.every(role => data.assignable.includes(role) || !data.roles.includes(role));
  }

  return (
    <section className="rounded-[16px] elevated">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <h2 className="font-medium">People with a role</h2>
        {data.canAssign && <Button size="sm" disabled={!data.assignable.length} onClick={() => setAdding(true)}><UserPlusIcon /> Add person</Button>}
      </div>
      {data.people.length === 0 && (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          Nobody yet. {emptyHint ?? (data.canAssign ? (data.roles.length ? "Add someone to give them a role here." : "The site has no roles yet: add some on its Roles page first.") : "")}
        </p>
      )}
      <ul className="divide-y">
        {data.people.map(person => (
          <li key={person.principal} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <Person name={person.name} email={person.email} detail={person.invited ? `${person.email} · hasn't signed in yet` : undefined} />
            <div className="flex items-center gap-1">
              {changeable(person) ? (
                <RolesMenu roles={data.roles} assignable={data.assignable} value={person.roles} onChange={roles => void onAssign(who(person), roles)} />
              ) : person.roles.map(role => <Badge key={role} variant="secondary">{role}</Badge>)}
              {changeable(person) && <Button variant="ghost" size="icon-sm" aria-label={`Remove ${person.email ?? person.name}`} onClick={() => setRemoving(person)}><XIcon /></Button>}
            </div>
          </li>
        ))}
      </ul>

      <AddPersonDialog open={adding} onOpenChange={setAdding} roles={data.assignable} pending={pending}
        onAdd={(email, roles) => onAssign({ email }, roles).then(() => setAdding(false), () => {})} />

      <AlertDialog open={removing !== null} onOpenChange={open => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name ?? removing?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose their roles on this site ({removing?.roles.join(", ")}) from their next sign-in, within about 10 minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={() => removing && onUnassign(removing.principal).then(() => setRemoving(null), () => {})}>
              {pending && <Spinner />} Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function RolesMenu({ roles, assignable, value, onChange }: { roles: string[], assignable: string[], value: string[], onChange(next: string[]): void }) {
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
        <DropdownMenuGroup>
          <DropdownMenuLabel>Roles on this site</DropdownMenuLabel>
          {roles.map(role => (
            <DropdownMenuCheckboxItem key={role} checked={value.includes(role)} disabled={!assignable.includes(role)} onCheckedChange={on => onChange(on ? [...value, role] : value.filter(r => r !== role))}>{role}</DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        {unknown.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Not on the site any more, so ignored:</DropdownMenuLabel>
              {unknown.map(role => <DropdownMenuCheckboxItem key={role} checked onCheckedChange={() => onChange(value.filter(r => r !== role))}>{role}</DropdownMenuCheckboxItem>)}
            </DropdownMenuGroup>
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
