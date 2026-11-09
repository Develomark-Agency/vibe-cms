import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { useNav, useSession } from "../app.tsx";
import type { Field, FormValues } from "../fields.ts";
import { normalizePrefix, normalizeSite, type Site } from "../site.ts";
import { useSticky } from "../system.ts";
import { Form, List, Title, useHints, useKeys, useSize, type ListItem } from "../ui.tsx";

const fields: Field[] = [
  { key: "url", label: "Address", kind: "string", required: true, placeholder: "localhost:1337 or client.com", description: "The site's address. Without http(s), local addresses get http and the rest https" },
  { key: "prefix", label: "CMS path", kind: "string", required: false, placeholder: "/_vibe", description: "Where the CMS is mounted, if not /_vibe" }
];

/**
 * Picks the site to work on: one running on this machine, a recent one, or a new address. `then` runs once
 * it's chosen, instead of going back.
 */
export function SiteScreen({ then }: { then?: () => void }) {
  const session = useSession();
  const nav = useNav();
  const { width, height } = useSize();
  const [typing, setTyping] = useState(false);
  const [values, setValues] = useSticky<FormValues>("site:form", { url: process.env.VIBE_SITE ?? "", prefix: "" });
  const [error, setError] = useState<string>();

  // Sites come and go while you work: look again each time this screen opens.
  useEffect(() => {
    if(session.local !== "scanning") void session.scan();
    void session.loadOrg();
  }, []);

  function choose(site: Site) {
    void session.connect(site);
    if(then) then();
    else nav.pop();
  }
  function submit() {
    const url = normalizeSite(String(values.url ?? ""));
    if(!url) return setError("That isn't a site address, like localhost:1337 or https://client.com");
    choose({ url, prefix: normalizePrefix(String(values.prefix ?? "")) });
  }

  useHints(typing
    ? [{ keys: "↑↓", label: "field" }, { keys: "enter", label: "next / connect" }, { keys: "esc", label: "list" }]
    : [{ keys: "↑↓", label: "move" }, { keys: "enter", label: "connect" }, { keys: "r", label: "look again" }, { keys: "n", label: "new address" }, { keys: "esc", label: "back" }]);
  useKeys((input, key) => {
    if(key.escape) {
      if(typing) setTyping(false);
      else nav.pop();
    } else if(!typing && input === "n") setTyping(true);
    else if(!typing && input === "r" && session.local !== "scanning") {
      void session.scan();
      void session.loadOrg();
    }
  });

  function isCurrent(site: Site) {
    return session.site?.url === site.url && session.site.prefix === site.prefix;
  }
  const local = session.local !== "scanning" && session.local.ok ? session.local.sites : [];
  const sites = new Map<string, Site>();
  const items: ListItem[] = [{ id: "h:local", label: "RUNNING ON THIS MACHINE", heading: true }];
  if(session.local === "scanning") items.push({ id: "h:scanning", label: "  Looking…", heading: true });
  else if(!session.local.ok) items.push({ id: "h:reason", label: `  ${session.local.reason} Press n to type an address.`, heading: true });
  else if(!local.length) items.push({ id: "h:none", label: "  No Vibe CMS sites running here. Start one, then press r.", heading: true });
  for(const site of local) {
    const id = `local:${site.url}${site.prefix}`;
    sites.set(id, site);
    const where = site.url.replace(/^http:\/\//, "") + (site.prefix === "/_vibe" ? "" : site.prefix);
    items.push({
      id,
      label: site.name,
      mark: site.dev ? { text: "dev ", color: "green" } : { text: "    " },
      hint: [where, site.folder].filter(Boolean).join("  ") + (isCurrent(site) ? "  · current" : "")
    });
  }
  const same = (a: Site, b: Site) => a.url === b.url && a.prefix === b.prefix;
  const org = session.org;
  const orgSites = typeof org === "object" && org.state === "ok" ? org.sites : [];
  if(org === "loading" || org.state !== "none") {
    const title = typeof org === "object" && org.state === "ok" && org.org ? org.org.toUpperCase() : "YOUR ORG";
    items.push({ id: "gap:org", label: " ", heading: true }, { id: "h:org", label: title, heading: true });
    if(org === "loading") items.push({ id: "h:org-loading", label: "  Looking…", heading: true });
    else if(org.state === "error") items.push({ id: "h:org-error", label: `  ${org.message}`, heading: true });
    else if(!org.sites.length) items.push({ id: "h:org-none", label: "  No sites on the org yet, or none you can see.", heading: true });
  }
  for(const site of orgSites) {
    const id = `org:${site.url}${site.prefix}`;
    sites.set(id, site);
    const where = site.url.replace(/^https:\/\//, "") + (site.prefix === "/_vibe" ? "" : site.prefix);
    items.push({ id, label: site.name || where, hint: [site.name ? where : undefined, isCurrent(site) ? "current" : undefined].filter(Boolean).join("  ") || undefined });
  }
  const recent = session.recent.filter(site => !local.some(l => same(l, site)) && !orgSites.some(o => same(o, site)));
  items.push({ id: "gap:recent", label: " ", heading: true }, { id: "h:recent", label: "RECENT", heading: true });
  for(const site of recent) {
    const id = `recent:${site.url}${site.prefix}`;
    sites.set(id, site);
    const where = site.url + (site.prefix === "/_vibe" ? "" : site.prefix);
    items.push({ id, label: site.name ?? where, hint: [site.name ? where : undefined, isCurrent(site) ? "current" : undefined].filter(Boolean).join("  ") || undefined });
  }
  items.push({ id: "new", label: "Another site…", color: "cyan" });

  return (
    <Box flexDirection="column">
      <Title>Which site?</Title>
      {typing ? (
        <>
          <Form fields={fields} values={values} onChange={v => { setValues(v); setError(undefined); }} onSubmit={submit} submitLabel="Connect" stickyKey="site" width={width} />
          {error ? <Text color="red">{error}</Text> : null}
        </>
      ) : (
        <List
          items={items}
          height={Math.min(items.length, height - 3)}
          stickyKey="site:list"
          onSelect={item => {
            if(item.id === "new") return setTyping(true);
            const site = sites.get(item.id);
            if(site) choose({ url: site.url, prefix: site.prefix, ...site.name ? { name: site.name } : {} });
          }}
        />
      )}
    </Box>
  );
}
