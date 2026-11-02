import { useCallback, useEffect, useRef, useState } from "react";
import type { AnyConfig } from "../config.ts";
import type { CollectionMarker } from "../config.ts";
import type { QueryBuilder, QueryClient, QueryOptions, QueryRequest } from "../query/index.ts";

type Requests = Record<string, QueryRequest>;

/** What `useContent` returns: loading, then either the results keyed like the requests, or the error. */
export type ContentState<R extends Requests> =
  | { loading: true, error: undefined, data: undefined, refresh(): void }
  | { loading: false, error: Error, data: undefined, refresh(): void }
  | { loading: false, error: undefined, data: { [K in keyof R]: Awaited<R[K]> }, refresh(): void };

/**
 * Runs the queries when the component mounts, batched into one request, and again when `deps` change.
 * No live updates; `refresh()` re-runs them.
 *
 * See `vibe-cms docs http-client`.
 */
export function useContent<C extends AnyConfig, R extends Requests>(
  cms: QueryClient<C>,
  build: (q: <T extends CollectionMarker>(collection: T, options?: QueryOptions) => QueryBuilder<C, T>) => R,
  deps: unknown[] = []
): ContentState<R> {
  const [state, setState] = useState<{ loading: boolean, error?: Error, data?: unknown }>({ loading: true });
  const [version, setVersion] = useState(0);
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => {
    let cancelled = false;
    setState(s => ({ ...s, loading: true }));
    const requests = buildRef.current((collection, options) => cms.query(collection as never, options) as never);
    const keys = Object.keys(requests);
    cms.batch(keys.map(k => requests[k]!)).then(
      results => {
        if(cancelled) return;
        setState({ loading: false, data: Object.fromEntries(keys.map((k, i) => [k, results[i]])) });
      },
      error => {
        if(!cancelled) setState({ loading: false, error: error as Error });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [cms, version, ...deps]);

  const refresh = useCallback(() => setVersion(v => v + 1), []);
  return { ...state, refresh } as ContentState<R>;
}
