import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";
import { FingerprintIcon, KeyRoundIcon, LogInIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { read, siteApi, type SiteInfo } from "./client.ts";
import { embedded } from "./session.ts";

/**
 * Signing in, however the site does it: through its org's hub (framed by the panel), with its own
 * identity provider, or with passkeys. Setup and invite links arrive in the URL's fragment, which
 * never reaches a server log.
 */

function fragment(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
}

function clearFragment() {
  history.replaceState(history.state, "", location.pathname + location.search);
}

export function SignIn({ info, error, onSignedIn }: { info: SiteInfo, error: string | null, onSignedIn(): Promise<void> }) {
  const auth = useQuery({ queryKey: ["auth"], queryFn: async () => read(await siteApi(info.prefix).auth.$get()), staleTime: Infinity });
  const [link] = useState(fragment);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(link.error ?? error);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await task();
      clearFragment();
      await onSignedIn();
    } catch (e) {
      const message = (e as Error).name === "NotAllowedError" ? "The passkey request was cancelled or timed out." : (e as Error).message;
      setProblem(message);
    } finally {
      setBusy(false);
    }
  }

  async function registerPasskey(input: Record<string, unknown>) {
    const { challengeId, options } = await read(await siteApi(info.prefix).auth.passkey.register.options.$post({ json: input }));
    const response = await startRegistration({ optionsJSON: options });
    await read(await siteApi(info.prefix).auth.passkey.register.$post({ json: { challengeId, response } }));
  }

  async function usePasskey() {
    const { challengeId, options } = await read(await siteApi(info.prefix).auth.passkey.login.options.$post());
    const response = await startAuthentication({ optionsJSON: options });
    await read(await siteApi(info.prefix).auth.passkey.login.$post({ json: { challengeId, response } }));
  }

  const mode = auth.data?.mode;
  let body: React.ReactNode = <Spinner className="size-5" />;

  if(mode === "hub" || (!mode && auth.isError)) {
    body = (
      <>
        <p className="text-sm text-balance text-muted-foreground">
          {embedded
            ? "Waiting for your agency panel to sign you in…"
            : "This editor only opens inside your agency's panel, which signs you in. This page has no password form."}
        </p>
        {info.hub && <a className="text-sm font-medium text-primary underline-offset-4 hover:underline" href={`${info.hub}/s/${encodeURIComponent(info.site.id)}/`}>Open in {new URL(info.hub).host}</a>}
      </>
    );
  } else if(mode === "oidc") {
    const href = `${info.prefix}/api/auth/oidc/login${link.setup ? `?setup=${encodeURIComponent(link.setup)}` : ""}`;
    body = (
      <>
        <p className="text-sm text-balance text-muted-foreground">
          {link.setup ? "You're setting up this site. Whoever signs in with this link becomes its owner." : auth.data!.setup ? "Nobody can sign in yet. Open the setup link from the site's logs to become its owner." : "Sign in with your work account."}
        </p>
        <Button nativeButton={false} render={<a href={href} />} className="w-full"><LogInIcon /> Sign in with {auth.data!.provider}</Button>
      </>
    );
  } else if(mode === "passkey" && link.setup) {
    body = <SetupForm busy={busy} onSubmit={(email, name) => run(() => registerPasskey({ setup: link.setup, email, name }))} />;
  } else if(mode === "passkey" && link.invite) {
    body = (
      <>
        <p className="text-sm text-balance text-muted-foreground">You've been invited to edit this site. Create a passkey on this device to sign in: your fingerprint, face or screen lock, no password.</p>
        <Button className="w-full" disabled={busy} onClick={() => run(() => registerPasskey({ invite: link.invite }))}>
          {busy ? <Spinner /> : <FingerprintIcon />} Create a passkey
        </Button>
      </>
    );
  } else if(mode === "passkey") {
    body = (
      <>
        <p className="text-sm text-balance text-muted-foreground">
          {auth.data!.setup ? "Nobody can sign in yet. Open the setup link from the site's logs to become its owner." : "Sign in with the passkey you created when you were invited. New device or lost passkey? Ask the site's owner to invite you again."}
        </p>
        {!auth.data!.setup && (
          <Button className="w-full" disabled={busy} onClick={() => run(usePasskey)}>
            {busy ? <Spinner /> : <FingerprintIcon />} Sign in with a passkey
          </Button>
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-sidebar p-8">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-[24px] elevated px-8 py-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-[14px] raised-brand">
          <KeyRoundIcon className="size-5" />
        </div>
        <div className="flex w-full flex-col items-center gap-3">
          <p className="eyebrow">Editor</p>
          <h1 className="text-xl font-medium tracking-tight">{info.site.name}</h1>
          {body}
        </div>
        {problem && <p role="alert" className="rounded-[12px] bg-destructive/10 px-3 py-2 text-sm text-destructive">{problem}</p>}
      </div>
    </div>
  );
}

function SetupForm({ busy, onSubmit }: { busy: boolean, onSubmit(email: string, name: string): void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  return (
    <form
      className="flex w-full flex-col gap-3 text-left"
      onSubmit={event => {
        event.preventDefault();
        onSubmit(email.trim(), name.trim());
      }}
    >
      <p className="text-center text-sm text-balance text-muted-foreground">You're setting up this site. You'll be its owner, and can invite everyone else.</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="setup-email">Email</Label>
        <Input id="setup-email" type="email" required autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="setup-name">Name</Label>
        <Input id="setup-name" autoComplete="name" value={name} onChange={event => setName(event.target.value)} />
      </div>
      <Button type="submit" disabled={busy || !email.trim()}>{busy ? <Spinner /> : <FingerprintIcon />} Create a passkey</Button>
    </form>
  );
}
