import { useSyncExternalStore } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog.tsx";

/**
 * Asking before something can't be undone, as a dialog rather than the browser's `confirm()`. Call
 * `askConfirm` from anywhere; `<ConfirmHost />`, mounted once per app, shows it.
 */

export interface ConfirmRequest {
  title: string,
  description: string,
  /** The confirming button's label. */
  action: string,
  /** Red, for deleting and removing. */
  destructive?: boolean,
  /** The cancelling button's label. Defaults to "Cancel". */
  cancel?: string
}

let current: (ConfirmRequest & { resolve(ok: boolean): void }) | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(listener => listener());
}

/** Resolves true when confirmed, false when cancelled or dismissed. A second request cancels the first. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  current?.resolve(false);
  return new Promise(resolve => {
    current = { ...request, resolve };
    emit();
  });
}

function settle(ok: boolean) {
  const request = current;
  current = null;
  emit();
  request?.resolve(ok);
}

export function ConfirmHost() {
  const request = useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => current);
  return (
    <AlertDialog open={request !== null} onOpenChange={open => !open && settle(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          <AlertDialogDescription>{request?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{request?.cancel ?? "Cancel"}</AlertDialogCancel>
          <AlertDialogAction variant={request?.destructive ? "destructive" : "default"} onClick={() => settle(true)}>{request?.action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Leaving with unsaved edits: the same question everywhere. */
export function confirmLeave(): Promise<boolean> {
  return askConfirm({ title: "Leave without saving?", description: "Your unsaved changes will be lost.", action: "Leave", destructive: true, cancel: "Keep editing" });
}
