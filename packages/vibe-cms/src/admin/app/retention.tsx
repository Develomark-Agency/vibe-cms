import { SettingsIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { ApiError } from "./client.ts";

export const MAX_RETENTION_DAYS = 3650;

/**
 * A page's "how long is this kept" setting: a button that opens a small dialog. Only shown to people who may
 * change it; `onSave` is the action that stores the number, and the page refreshes what it shows afterwards.
 */
export function RetentionButton({ title, description, days, onSave }: {
  title: string,
  description: string,
  days: number | undefined,
  onSave: (days: number) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_RETENTION_DAYS;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if(!valid || saving) return;
    setSaving(true);
    try {
      await onSave(parsed);
      toast.success("Saved");
      setOpen(false);
    } catch(error) {
      toast.error(error instanceof ApiError ? error.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="outline" disabled={days === undefined} onClick={() => { setValue(String(days)); setOpen(true); }}>
        <SettingsIcon /> Retention
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="retention-days">Days</Label>
              <Input id="retention-days" type="number" inputMode="numeric" min={1} max={MAX_RETENTION_DAYS} step={1} value={value} autoFocus
                aria-invalid={value !== "" && !valid} onChange={event => setValue(event.target.value)} />
              <p className="text-xs text-muted-foreground">Between 1 and {MAX_RETENTION_DAYS}.</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!valid || saving || parsed === days}>{saving && <Spinner />} Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
