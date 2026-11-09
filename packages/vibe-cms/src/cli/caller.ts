import pkg from "../../package.json" with { type: "json" };

/** How the CLI identifies itself to sites' activity logs. */
export const CLI_CALLER = { via: "cli", client: `vibe-cms/${pkg.version}` } as const;
