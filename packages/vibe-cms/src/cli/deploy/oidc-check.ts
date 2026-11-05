import { normalizeIssuer, type Discovery } from "../../oidc/index.ts";

/** Providers the wizard knows something useful about, by where their issuer lives. */
export type KnownProvider = "access" | "clerk" | "google" | null;

export interface OidcCheck {
  /** The issuer cleaned up: no trailing slash, and not the discovery URL. */
  issuer: string,
  provider: KnownProvider,
  /** Things that mean sign-in can't work. */
  errors: string[],
  /** Things that work but with a catch the person should know before deploying. */
  warnings: string[],
  /** What the provider offers that the panel will use. */
  notes: string[],
  /** The provider doesn't list `email_verified`, so "trust its emails" is a decision to make. */
  asksAboutEmail: boolean
}

export function providerOf(issuer: string): KnownProvider {
  const host = URL.canParse(issuer) ? new URL(issuer).host : "";
  if(host.endsWith(".cloudflareaccess.com")) return "access";
  if(host.endsWith(".clerk.accounts.dev") || host.startsWith("clerk.") || host.endsWith(".clerk.com")) return "clerk";
  if(host === "accounts.google.com") return "google";
  return null;
}

/** What to tell people setting up with a provider the wizard recognizes. */
export function providerHint(provider: KnownProvider): string | null {
  if(provider === "access") {
    return "Cloudflare Access: in Zero Trust, add a SaaS application of type OIDC, with the scopes openid, email and profile (add groups to let group names decide who signs in), and the redirect URL shown at the end. Its Access policies decide who can sign in, so \"who may sign in\" can stay empty.";
  }
  if(provider === "clerk") {
    return "Clerk: in the Dashboard, add an OAuth application with the scopes openid, email, profile and offline_access, and copy its client secret now (Clerk shows it once). Add the redirect URI shown at the end to the application.";
  }
  return null;
}

/**
 * Looks at a provider's discovery document before anything is deployed, and says what will and won't
 * work. It can't check the client ID or secret: only signing in does that.
 */
export async function checkProvider(input: string, fetcher: typeof fetch = fetch): Promise<OidcCheck> {
  const issuer = normalizeIssuer(input);
  const provider = providerOf(issuer);
  const check: OidcCheck = { issuer, provider, errors: [], warnings: [], notes: [], asksAboutEmail: false };
  let doc: Discovery;
  try {
    const response = await fetcher(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if(!response.ok) {
      check.errors.push(`${issuer}/.well-known/openid-configuration answered ${response.status}. The issuer should be the address that serves it, without the .well-known part.`);
      return check;
    }
    doc = await response.json() as Discovery;
  } catch (error) {
    check.errors.push(`Couldn't read ${issuer}/.well-known/openid-configuration (${(error as Error).message}).`);
    return check;
  }
  const missing = ["authorization_endpoint", "token_endpoint", "jwks_uri"].filter(field => !(doc as unknown as Record<string, unknown>)[field]);
  if(missing.length) check.errors.push(`That isn't an OpenID Connect provider: its discovery document has no ${missing.join(", ")}.`);
  if(doc.code_challenge_methods_supported && !doc.code_challenge_methods_supported.includes("S256")) check.errors.push("The provider doesn't support PKCE with S256, which the panel always uses.");
  const methods = doc.token_endpoint_auth_methods_supported;
  if(methods && !methods.includes("client_secret_basic") && !methods.includes("client_secret_post")) {
    check.errors.push(`The provider only accepts ${methods.join(", ")} at its token endpoint; the panel signs in with a client secret.`);
  }
  if(check.errors.length) return check;

  if(provider === "google" || doc.scopes_supported?.includes("offline_access")) {
    check.notes.push("It offers refresh tokens, so sign-ins can be renewed without asking people to sign in again.");
  } else {
    check.warnings.push("The provider doesn't list offline_access, so it may give no refresh tokens. If so, using a site through the panel stops working when the ID token expires and people have to sign in again.");
  }
  // Not listed (or no list at all): the provider may leave email_verified out of its tokens.
  check.asksAboutEmail = !doc.claims_supported?.includes("email_verified");
  return check;
}
