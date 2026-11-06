import { styleText } from "node:util";
import { command, subcommands } from "cmd-ts";
import { exportJWK, generateKeyPair } from "jose";

/**
 * `vibe-cms hub keygen`: a signing key for the hub, printed once. Store it as a Worker secret
 * (`wrangler secret put HUB_SIGNING_KEY`), which can be set but never read back.
 */
export async function generateHubKey(): Promise<string> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
  return JSON.stringify({ ...(await exportJWK(privateKey)), kid, alg: "ES256" });
}

const keygen = command({
  name: "keygen",
  description: "Generate the hub's signing key (HUB_SIGNING_KEY)",
  args: {},
  examples: [{ description: "Store a new key straight into the hub's secrets", command: "npx vibe-cms hub keygen | wrangler secret put HUB_SIGNING_KEY" }],
  async handler() {
    const key = await generateHubKey();
    process.stdout.write(`${key}\n`);
    if(process.stdout.isTTY) {
      console.error(styleText("dim", "\n  Store it with `wrangler secret put HUB_SIGNING_KEY` and keep no other copy."));
      console.error(styleText("dim", "  Replacing it later is safe: sites fetch the new key the first time they see it, and site sessions carry on.\n"));
    }
  }
});

export const hubCommand = subcommands({
  name: "hub",
  description: "Set up an org's hub (panel)",
  cmds: { keygen }
});
