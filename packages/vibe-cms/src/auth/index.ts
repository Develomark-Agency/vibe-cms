/** The agency hub (panel) editors, the CLI and agents sign in through. */
export interface HubOptions {
  /** The hub's address, e.g. `https://edit.my-agency.com`: the expected `iss`, and where its keys are. */
  url: string,
  /** Identity provider claim to read roles from, e.g. `"groups"`. The hub passes it through. */
  roles?: string
}

/** What `hub()` returns, for the config's `auth`. */
export interface AuthDescriptor extends HubOptions {
  kind: "auth",
  type: "hub"
}

/**
 * Sign-in for deployed sites: the site accepts tokens the hub at this address signed for this
 * site, and decides roles itself. Development sites don't need it. See `vibe-cms docs permissions`.
 */
export function hub(options: HubOptions): AuthDescriptor {
  return { kind: "auth", type: "hub", ...options, url: options.url.replace(/\/$/, "") };
}
