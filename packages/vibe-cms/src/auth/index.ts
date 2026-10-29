export interface OidcOptions {
  /** The identity provider's issuer URL. Discovery happens at runtime. */
  issuer: string,
  /** The panel's client ID at the provider: the expected `aud` of ID tokens. */
  clientId: string,
  /** Claim to read roles from, e.g. `"groups"`. */
  roles?: string
}

export interface AuthDescriptor extends OidcOptions {
  kind: "auth",
  type: "oidc"
}

export function oidc(options: OidcOptions): AuthDescriptor {
  return { kind: "auth", type: "oidc", ...options };
}
