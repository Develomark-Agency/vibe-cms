import { useEffect, useState } from "react";
import { defineAdmin, type AdminClient } from "vibe-cms/admin";

function useJson<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  useEffect(() => {
    load().then(setData);
  }, deps);
  return data;
}

// Registered as "/", so it's the editor page /_vibe/admin/p/stats.
function StatsPage({ cms }: { cms: AdminClient, params: Record<string, string> }) {
  // `cms.api` paths starting with /plugins/ go to /_vibe/plugins/…, everything else to /_vibe/api/….
  const summary = useJson(() => cms.api<{ drafts: number, published: number, pinned: number }>("/plugins/stats/summary"));
  // `cms.plugins.<plugin>.<route>(body)` is a POST to /_vibe/plugins/<plugin>/<route> with a JSON body.
  const latest = useJson(() => cms.plugins.stats!.latest!({ limit: 3 }) as Promise<Array<{ title: string, slug: string }>>);
  return (
    <div>
      <h1>Stats</h1>
      <p>{summary ? `${summary.published} published, ${summary.drafts} in total, ${summary.pinned} pinned` : "Loading…"}</p>
      <ul>
        {latest?.map(p => (
          // `cms.navigate` takes editor paths, without /_vibe/admin: this opens /_vibe/admin/p/stats/words/<slug>.
          <li key={p.slug}><button type="button" onClick={() => cms.navigate(`/p/stats/words/${p.slug}`)}>{p.title}</button></li>
        ))}
      </ul>
    </div>
  );
}

// Registered as "/words/:slug": /_vibe/admin/p/stats/words/<slug>, with `params.slug`.
function WordsPage({ cms, params }: { cms: AdminClient, params: Record<string, string> }) {
  const words = useJson(() => cms.api<{ words: number }>(`/plugins/stats/words/${params.slug}`), [params.slug]);
  return <p>{params.slug}: {words ? `${words.words} words` : "Loading…"}</p>;
}

export default defineAdmin(() => ({
  // Page keys and nav `to` are relative to the plugin: the editor prefixes them with /p/stats.
  pages: {
    "/": { title: "Stats", component: StatsPage },
    "/words/:slug": { title: "Words", component: WordsPage }
  },
  slots: {
    nav: [{ label: "Stats", to: "/", icon: "chart-bar" }]
  }
}));
