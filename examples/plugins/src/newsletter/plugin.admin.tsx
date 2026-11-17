import { useEffect, useState } from "react";
import { defineAdmin, type AdminClient } from "vibe-cms/admin";

// Only people with the apiKey permission see this page and its nav link (`permit` below).
function KeyPage({ cms }: { cms: AdminClient, params: Record<string, string> }) {
  const [key, setKey] = useState<{ set: boolean, ending: string | null }>();
  const [next, setNext] = useState("");
  useEffect(() => {
    cms.api<{ set: boolean, ending: string | null }>("/plugins/newsletter/key").then(setKey);
  }, []);
  // `cms.can` names permissions in full, `<plugin>.<permission>`. It only decides what to show: the route checks too.
  const canEdit = cms.can("newsletter.apiKey", "edit");
  return (
    <div>
      <h1>Newsletter</h1>
      <p>{!key ? "Loading…" : key.set ? `API key ending in ${key.ending}` : "No API key yet"}</p>
      {canEdit && (
        <form onSubmit={async event => {
          event.preventDefault();
          await cms.api("/plugins/newsletter/key", { method: "PUT", json: { key: next } });
          setKey({ set: true, ending: next.slice(-4) });
          setNext("");
          cms.toast("Key saved", { type: "success" });
        }}>
          <input type="password" value={next} onChange={event => setNext(event.target.value)} aria-label="New API key" />
          <button type="submit" disabled={!next}>Replace key</button>
        </form>
      )}
    </div>
  );
}

export default defineAdmin(() => ({
  // `permit` names the plugin's own permission, as actions do: any level here.
  pages: {
    "/": { title: "Newsletter", component: KeyPage, permit: { permission: "apiKey" } }
  },
  slots: {
    nav: [{ label: "Newsletter", to: "/", icon: "mail", permit: { permission: "apiKey" } }]
  }
}));
