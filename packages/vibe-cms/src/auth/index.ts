/** The identity provider editors sign in with, through the agency panel. */
export interface OidcOptions {
  /** The identity provider's issuer URL. Discovery happens at runtime. */
  issuer: string,
  /** The panel's client ID at the provider: the expected `aud` of ID tokens. */
  clientId: string,
  /** Claim to read roles from, e.g. `"groups"`. */
  roles?: string
}

/** What `oidc()` returns, for the config's `auth`. */
export interface AuthDescriptor extends OidcOptions {
  kind: "auth",
  type: "oidc"
}

/**
 * Sign-in for deployed sites: the site verifies ID tokens from this issuer for this client ID,
 * handed over by the panel. Development sites don't need it. See `vibe-cms docs permissions`.
 */
export function oidc(options: OidcOptions): AuthDescriptor {
  return { kind: "auth", type: "oidc", ...options };
}
