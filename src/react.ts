/** React bindings — a live sheet as a hook, built on `createCache()`.
 *
 *      import { connect } from "gsab";
 *      import { useSheet } from "gsab/react";
 *
 *      const db = connect(SHEET_URL).sheet();          // module scope
 *      function Users() {
 *        const { rows, loading, error } = useSheet(db, { key: "id" });
 *        if (loading) return <Spinner />;
 *        return <ul>{rows.map((r) => <li key={String(r.id)}>{String(r.name)}</li>)}</ul>;
 *      }
 *
 *  Passing a SheetManager gives the component its own poller (started on mount, stopped on
 *  unmount). To share ONE poller across many components, create the cache yourself and pass
 *  it in — a never-started cache is started for you (and left running); one you stopped
 *  stays stopped, and the hook never stops a cache it didn't create:
 *
 *      const cache = createCache(db, { key: "id" });   // app level / context
 *      useSheet(cache);
 *
 *  Experimental — same polling envelope as `createCache()`. */
"use client";

import { useMemo, useSyncExternalStore } from "react";

import { SheetCache, createCache } from "./cache";
import type { CacheOptions } from "./cache";
import type { Row, SheetManager } from "./manager";

export interface UseSheetResult<T extends Row = Row> {
  /** Current rows (empty until the first snapshot loads). */
  rows: T[];
  /** True until the initial snapshot has loaded. */
  loading: boolean;
  /** The last poll error, or undefined. Cleared by the next successful poll; if the
   *  INITIAL load failed there is no next poll — `refresh()` retries and restarts it. */
  error: unknown;
  /** The underlying cache — escape hatch for `get()`, `on()`, `size`, … */
  cache: SheetCache;
  /** Re-read now instead of waiting for the next poll. Failures land in `error`. */
  refresh: () => Promise<void>;
}

type State = { rows: Row[]; loading: boolean; error: unknown };

interface Store {
  cache: SheetCache;
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => State;
  refresh: () => Promise<void>;
}

function makeStore(source: SheetManager | SheetCache, opts: CacheOptions): Store {
  const owned = !(source instanceof SheetCache);
  const cache = owned ? createCache(source, opts) : source;
  let state: State = { rows: cache.all(), loading: !cache.loaded, error: undefined };
  const listeners = new Set<() => void>();
  const offs: Array<() => void> = [];

  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    for (const onChange of listeners) onChange();
  };

  const attach = () => {
    offs.push(
      cache.on("ready", (rows) => set({ rows, loading: false, error: undefined })),
      cache.on("change", () => set({ rows: cache.all(), error: undefined })),
      // A successful no-change poll emits no `change`; still clear a stale error.
      cache.on("sync", () => {
        if (state.error !== undefined) set({ error: undefined });
      }),
      cache.on("error", (error) => set({ error })),
    );
    // A shared cache may have synced between our render and this subscribe — catch up.
    if (cache.loaded) set({ rows: cache.all(), loading: false });
    // Start our own cache always (idempotent); a shared one only if it was never started —
    // a cache the caller deliberately stopped stays stopped.
    if (owned || (!cache.running && !cache.loaded)) {
      cache.start().then(
        () => {
          if (state.loading) set({ rows: cache.all(), loading: false });
        },
        (error) => set({ error, loading: false }), // start() cleaned up; refresh() retries
      );
    }
  };

  const detach = () => {
    for (const off of offs.splice(0)) off();
    if (owned) cache.stop();
  };

  return {
    cache,
    subscribe(onChange) {
      listeners.add(onChange);
      if (listeners.size === 1) attach();
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) detach();
      };
    },
    getSnapshot: () => state,
    async refresh() {
      try {
        // If our own poller died on a failed initial load, retry the whole start —
        // a bare refresh() would fetch rows but leave the cache unpolled forever.
        if (owned && !cache.running) await cache.start();
        else await cache.refresh();
        set({ rows: cache.all(), loading: false, error: undefined });
      } catch (error) {
        set({ error });
      }
    },
  };
}

/** Subscribe a component to a sheet's live rows. See the module docs above.
 *
 *  `source` — a SheetManager (`connect(url).sheet()`; the hook owns the poller) or a shared
 *  SheetCache (`createCache(...)`; the hook only subscribes). `opts` applies when a manager
 *  is passed; `opts.filters` is compared by value, so an inline literal is fine. */
export function useSheet<T extends Row = Row>(
  source: SheetManager | SheetCache,
  opts: CacheOptions = {},
): UseSheetResult<T> {
  const { interval, key } = opts;
  const filtersKey = JSON.stringify(opts.filters ?? null);
  // Recreate the store only when the source or a meaningful option actually changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => makeStore(source, opts), [source, interval, key, filtersKey]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    rows: state.rows as T[],
    loading: state.loading,
    error: state.error,
    cache: store.cache,
    refresh: store.refresh,
  };
}
