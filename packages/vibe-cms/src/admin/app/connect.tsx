import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlugIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { read, siteApi, type SessionState, type SiteInfo } from "./client.ts";
import { useAdmin } from "./context.tsx";
import { Page, PageHeader } from "./page.tsx";

/**
 * Connecting an agent or the CLI to a site that signs people in itself. The site's OAuth server sends
 * the browser here with `#connect=<request>`; the user signs in as usual, then approves or cancels.
 * The request survives a trip to the identity provider in sessionStorage.
 */

const KEY = "vibe:connect";

/** The connection request this page was opened for, if any. */
export function takeConnectRequest(): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("connect");
  try {
    if(fromHash) {
      sessionStorage.setItem(KEY, fromHash);
      history.replaceState(history.state, "", location.pathname + location.search);
      return fromHash;
    }
    return sessionStorage.getItem(KEY);
  } catch {
    return fromHash;
  }
}

function forgetConnectRequest() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}

export function ConnectApp({ info, session, id, onDone }: { info: SiteInfo, session: SessionState, id: string, onDone(): void }) {
  const described = useQuery({ queryKey: ["connect", id], queryFn: async () => read(await siteApi(info.prefix).oauth.request.$get({ query: { id } })), retry: false });
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  async function answer(allow: boolean) {
    setBusy(true);
    try {
      const { redirect } = await read(await siteApi(info.prefix).oauth.decide.$post({ json: { request: id, allow, readOnly } }));
      forgetConnectRequest();
      location.href = redirect;
    } catch (error) {
      toast.error((error as Error).message);
      setBusy(false);
    }
  }

  const who = session.user.email ?? session.user.name ?? "your account";
  return (
    <div className="flex min-h-full items-center justify-center bg-sidebar p-8">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-[24px] elevated px-8 py-8">
        <div className="flex size-12 items-center justify-center rounded-[14px] raised-brand"><PlugIcon className="size-5" /></div>
        {described.isError ? (
          <>
            <h1 className="text-xl font-medium tracking-tight">Can't connect</h1>
            <p className="text-sm text-muted-foreground">{(described.error as Error).message}</p>
            <div className="flex justify-end"><Button variant="outline" onClick={() => {
              forgetConnectRequest();
              onDone();
            }}>Go to the editor</Button></div>
          </>
        ) : !described.data ? <Spinner className="size-5" /> : (
          <>
            <h1 className="text-xl font-medium tracking-tight">Connect {described.data.client}?</h1>
            <p className="text-sm text-muted-foreground">
              It will work on <strong className="font-medium text-foreground">{info.site.name}</strong> as <strong className="font-medium text-foreground">{who}</strong>, with your permissions here. You can disconnect it any time under Connected apps.
            </p>
            <p className="text-sm text-muted-foreground">
              {described.data.showsCode ? "Afterwards you'll get a code to paste into your terminal." : <>Afterwards you'll go back to <strong className="font-medium text-foreground">{described.data.returnsTo}</strong>.</>}
            </p>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={described.data.readOnlyOnly || readOnly} disabled={described.data.readOnlyOnly} onCheckedChange={checked => setReadOnly(Boolean(checked))} />
              <span>Read only: let it look, but not change anything</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => answer(false)}>Cancel</Button>
              <Button disabled={busy} onClick={() => answer(true)}>{busy ? <Spinner /> : <PlugIcon />} Connect</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The agents and CLIs the signed-in user connected to this site. */
export function ConnectionsPage() {
  const { info } = useAdmin();
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: ["connections"], queryFn: async () => read(await siteApi(info.prefix).oauth.connections.$get()) });
  const remove = useMutation({
    mutationFn: async (id: string) => read(await siteApi(info.prefix).oauth.connections[":id"].$delete({ param: { id } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
    onError: error => toast.error((error as Error).message)
  });
  useEffect(() => {
    document.title = `Connected apps · ${info.site.name}`;
  }, [info.site.name]);

  return (
    <Page>
      <PageHeader
        eyebrow="Settings"
        title="Connected apps"
        summary={<>
          AI agents and the <span className="whitespace-nowrap">Vibe CMS</span> CLI you connected to this site. Add <code className="font-mono text-xs">{`${location.origin}${info.prefix}/api/mcp`}</code> to an agent as a custom connector, or run <code className="font-mono text-xs">{`vibe-cms login --site ${location.origin}`}</code>.
        </>}
      />
      <section className="flex flex-col divide-y rounded-[16px] elevated">
        {!connections.data && <div className="p-4"><Spinner className="size-4" /></div>}
        {connections.data?.connections.length === 0 && <p className="p-4 text-sm text-muted-foreground">Nothing connected.</p>}
        {connections.data?.connections.map(connection => (
          <div key={connection.id} className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{connection.name}{connection.readOnly && <span className="text-muted-foreground"> · read only</span>}</p>
              <p className="text-xs text-muted-foreground">
                Connected {new Date(connection.connectedAt).toLocaleDateString()}
                {connection.lastUsedAt ? ` · last used ${new Date(connection.lastUsedAt).toLocaleDateString()}` : ""}
              </p>
            </div>
            <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(connection.id)}><Trash2Icon /> Disconnect</Button>
          </div>
        ))}
      </section>
    </Page>
  );
}
