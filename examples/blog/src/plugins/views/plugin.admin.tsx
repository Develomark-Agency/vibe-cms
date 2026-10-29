import { useQuery } from "@tanstack/react-query";
import { EyeIcon } from "lucide-react";
import { defineAdmin, type AdminClient, type DocumentSlotProps } from "vibe-cms/admin";

function useViews(cms: AdminClient, id: string | null) {
  return useQuery({
    queryKey: ["views", id],
    enabled: Boolean(id),
    queryFn: () => cms.api<{ views: number }>(`/plugins/views/views/${id}`)
  });
}

function ViewsPanel({ id, cms, value }: DocumentSlotProps) {
  const views = useViews(cms, id);
  return (
    <dl className="grid gap-1.5 text-sm">
      <div className="flex justify-between"><dt className="text-muted-foreground">Page views</dt><dd className="tabular-nums">{id ? views.data?.views ?? "…" : "—"}</dd></div>
      <div className="flex justify-between"><dt className="text-muted-foreground">Reading time</dt><dd>{typeof value.readingMinutes === "number" ? `${value.readingMinutes} min` : "Saved on next write"}</dd></div>
    </dl>
  );
}

function ViewsColumn({ doc, cms }: { doc: { id: string }, cms: AdminClient }) {
  const views = useViews(cms, doc.id);
  return <span className="inline-flex items-center gap-1 text-sm tabular-nums text-muted-foreground"><EyeIcon className="size-3.5" />{views.data?.views ?? "…"}</span>;
}

export default defineAdmin(({ cms }) => ({
  slots: {
    "document.sidebar": [{ id: "views", label: "Audience", types: ["post"], component: ViewsPanel }],
    "list.columns": [{ type: "post", id: "views", label: "Views", component: ViewsColumn }]
  },
  commands: [
    {
      id: "views.types",
      label: "Show which types count views",
      run: async () => {
        const { types } = await cms.api<{ types: string[] }>("/plugins/views/types");
        cms.toast(`Counting views for: ${types.join(", ")}`);
      }
    }
  ]
}));
