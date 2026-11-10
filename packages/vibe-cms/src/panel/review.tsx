import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../admin/components/ui/empty.tsx";
import { cn } from "../admin/lib/utils.ts";
import { formatRelative } from "../admin/app/context.tsx";
import { VIA_LABELS } from "../admin/app/via.ts";
import type { Via } from "../handler/activity.ts";
import type { PanelBackend, PanelUser } from "./backend.ts";
import { Loading, PageHeader } from "./access.tsx";
import { go } from "./location.ts";

/**
 * Everything awaiting publishing across the sites this person can see: who changed what, and where.
 * Opening one goes to its editor on the site, where Publish shows the changes.
 */
export function ReviewPage({ backend, user }: { backend: PanelBackend, user: PanelUser }) {
  const review = useQuery({ queryKey: ["review"], queryFn: () => backend.review!(), refetchInterval: 60_000 });

  useEffect(() => {
    document.title = "Review";
  }, []);

  if(review.isError) return <p className="p-12 text-center text-sm text-muted-foreground">{(review.error as Error).message}</p>;
  if(!review.data) return <Loading />;
  const sites = review.data.sites.filter(s => s.documents.length || s.error);
  const total = sites.reduce((n, s) => n + s.documents.length, 0);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-12 md:px-10">
      <PageHeader
        title="Review"
        description={total ? `${total === 1 ? "1 document has" : `${total} documents have`} unpublished changes.` : "Unpublished changes across your sites show up here."}
      />
      {!sites.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing to review</EmptyTitle>
            <EmptyDescription>When someone saves changes without publishing them, on any site you can see, they're listed here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {sites.map(({ site, documents, error }) => (
        <section key={site.id} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">{site.name}</h2>
          {error ? (
            <p className="flex items-center gap-2 rounded-[14px] well p-3 text-sm text-muted-foreground"><TriangleAlertIcon className="size-4" /> {error}</p>
          ) : (
            <ul className="divide-y overflow-hidden rounded-[16px] elevated">
              {documents.map(doc => (
                <li key={`${doc.type}/${doc.id}/${doc.locale}`}>
                  <button
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-foreground/[0.04]"
                    onClick={() => go(`/s/${encodeURIComponent(site.id)}/content/${doc.type}/${doc.id}${doc.locale ? `?locale=${encodeURIComponent(doc.locale)}` : ""}`)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{doc.title}</span>
                        <span className={cn("shrink-0 rounded-full px-1.5 text-[11px]", doc.live ? "bg-amber-500/12 text-amber-700 dark:text-amber-400" : "bg-foreground/[0.06] text-muted-foreground")}>
                          {doc.live ? "Changed" : "Not published"}
                        </span>
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {doc.type} · {doc.pending.map(p => `${p.owner === user.sub ? "You" : p.name ?? "Someone"}${p.via !== "ui" ? ` via ${VIA_LABELS[p.via as Via] ?? p.via}` : ""}`).join(", ")}
                        {!doc.canPublish && " · you can't publish this"}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(doc.updatedAt)}</span>
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
