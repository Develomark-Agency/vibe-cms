import tls from "node:tls";

/**
 * Makes the CLI trust what the operating system trusts, as browsers do. Node and Bun only trust their
 * own bundled list by default, so a local certificate authority that's been trusted in the system (a
 * dev proxy's, mkcert's, a company's) works in the browser but fails here with a certificate error.
 * Best effort: on a runtime that can't read the system store, nothing changes.
 */
export function trustSystemCertificates(readSystem = () => tls.getCACertificates("system")) {
  let ca: string[];
  try {
    const system = readSystem();
    if(!system.length) return;
    ca = [...new Set([...tls.getCACertificates("default"), ...system])];
  } catch {
    return;
  }
  if(process.versions.bun) {
    // Bun's fetch doesn't read Node's default list, but takes one per request.
    const bunFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => bunFetch(input, { ...init, tls: { ca, ...(init as { tls?: object } | undefined)?.tls } } as RequestInit),
      bunFetch
    );
  } else {
    try {
      tls.setDefaultCACertificates(ca);
    } catch {}
  }
}
