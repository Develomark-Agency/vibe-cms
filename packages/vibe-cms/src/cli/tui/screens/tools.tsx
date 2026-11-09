import { Box, Text } from "ink";
import { useState } from "react";
import { useNav, useSession } from "../app.tsx";
import { checkValues, type Field, type FormValues } from "../fields.ts";
import { copy, useSticky } from "../system.ts";
import { accent, ErrorBox, Form, Spinner, Title, useFlash, useHints, useKeys, useSize } from "../ui.tsx";
import { generateHubKey } from "../../hub.ts";

/** `vibe-cms hub keygen`, with the key to copy rather than pipe. */
export function KeygenScreen() {
  const nav = useNav();
  const [key, setKey] = useState<string>();
  const [flash, setFlash] = useFlash();
  useHints(key
    ? [{ keys: "c", label: "copy" }, { keys: "n", label: "another" }, { keys: "esc", label: "back" }]
    : [{ keys: "enter", label: "generate" }, { keys: "esc", label: "back" }]);
  useKeys((input, k) => {
    if(k.escape) nav.pop();
    else if((!key && k.return) || (key && input === "n")) void generateHubKey().then(setKey);
    else if(key && input === "c") setFlash(copy(key));
  });
  return (
    <Box flexDirection="column">
      <Title>Hub signing key</Title>
      <Text wrap="wrap">A new ES256 key for a hub's HUB_SIGNING_KEY secret. Store it with `wrangler secret put HUB_SIGNING_KEY` and keep no other copy.</Text>
      <Text dimColor wrap="wrap">Replacing it later is safe: sites fetch the new key the first time they see it, and site sessions carry on.</Text>
      <Box marginTop={1} flexDirection="column">
        {key ? (
          <Box borderStyle="round" borderColor={accent} paddingX={1}><Text wrap="wrap">{key}</Text></Box>
        ) : <Text><Text color={accent} inverse bold> Generate </Text></Text>}
      </Box>
      <Box marginTop={1}><Text dimColor>Or straight into the hub's secrets: </Text><Text color="cyan">vibe-cms hub keygen | wrangler secret put HUB_SIGNING_KEY</Text></Box>
      {flash ? <Text color="green">{flash}</Text> : null}
    </Box>
  );
}

const claimFields: Field[] = [
  { key: "site", label: "Site", kind: "string", required: true, placeholder: "https://client.com", description: "The site's address" },
  { key: "worker", label: "Worker", kind: "string", required: false, description: "The Cloudflare Worker that serves the site, if it can't be worked out from the address" },
  { key: "binding", label: "D1 binding", kind: "string", required: false, description: "The CMS's D1 binding, if the Worker has several and none is called DB" }
];

/** `vibe-cms admin claim-link`: asks the site to make its claim token, then reads it through wrangler's login. */
export function ClaimLinkScreen() {
  const session = useSession();
  const nav = useNav();
  const { width } = useSize();
  const [values, setValues] = useSticky<FormValues>("claim", () => ({ site: session.site && !/localhost|127\.0\.0\.1/.test(session.site.url) ? session.site.url : "" }));
  const [state, setState] = useState<"form" | "running" | "done" | "failed">("form");
  const [steps, setSteps] = useState<string[]>([]);
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useFlash();

  async function run() {
    const problem = checkValues(claimFields, values);
    if(problem) return setError(problem);
    setState("running");
    setSteps([]);
    setError(undefined);
    try {
      const { claimLinkFor, connect } = await import("../../claim.ts");
      function say(message: string) {
        return setSteps(s => [...s, message]);
      }
      say("Checking wrangler's login…");
      const lookup = await connect(undefined, say);
      function text(v: FormValues[string]) {
        return typeof v === "string" && v.trim() ? v.trim() : undefined;
      }
      setLink(await claimLinkFor(String(values.site), lookup, { worker: text(values.worker), binding: text(values.binding) }));
      setState("done");
    } catch (e) {
      setError((e as Error).message);
      setState("failed");
    }
  }

  useHints(state === "running" ? [] : state === "form"
    ? [{ keys: "↑↓", label: "field" }, { keys: "⌃R", label: "find it" }, { keys: "esc", label: "back" }]
    : [...link ? [{ keys: "c", label: "copy link" }, { keys: "a", label: "attach it" }] : [], { keys: "enter", label: "again" }, { keys: "esc", label: "back" }]);
  useKeys((input, key) => {
    if(state === "running") return;
    if(key.escape) nav.pop();
    else if(state !== "form" && key.return) setState("form");
    else if(state === "done" && link && input === "c") setFlash(copy(link));
    else if(state === "done" && link && input === "a") void session.runCommand(["admin", "attach", link]);
  });

  return (
    <Box flexDirection="column">
      <Title>Find a site's claim link</Title>
      <Box marginBottom={1}><Text dimColor wrap="wrap">For a newly deployed site without VIBE_ORG. Needs wrangler logged in to the account that owns the site.</Text></Box>
      {state === "form" ? <Form fields={claimFields} values={values} onChange={setValues} onSubmit={() => void run()} stickyKey="claim" width={width} submitLabel="Find it" /> : null}
      {state !== "form" ? steps.map((s, i) => <Text key={i} dimColor>  {s}</Text>) : null}
      {state === "running" ? <Spinner label="Working…" /> : null}
      {state === "done" && link ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green" bold>✓ The site's claim link</Text>
          <Box borderStyle="round" borderColor={accent} paddingX={1}><Text wrap="wrap">{link}</Text></Box>
          <Text dimColor>Hand it to the panel's Add a site box, or press a to attach it from here.</Text>
        </Box>
      ) : null}
      {error ? (state === "failed" ? <ErrorBox title="Couldn't get the link" message={error} /> : <Text color="red">✗ {error}</Text>) : null}
      {flash ? <Text color="green">{flash}</Text> : null}
    </Box>
  );
}
