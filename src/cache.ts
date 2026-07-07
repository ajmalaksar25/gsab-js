/** A reactive in-memory cache over one sheet: keeps a single snapshot, polls + diffs, and
 *  dispatches granular events (`insert` / `update` / `delete`). One poller feeds many
 *  listeners — cheaper than each view re-reading, and a Convex-like feel for a live UI.
 *
 *      const cache = createCache(db, { key: "id" });
 *      cache.on("insert", (row) => ...);
 *      cache.on("update", (row, prev) => ...);
 *      cache.on("delete", (row) => ...);
 *      await cache.start();        // resolves once the initial snapshot is loaded
 *      cache.all();                // the current rows
 *      cache.stop();               // stop polling
 *
 *  Experimental — polling (not push), inheriting the same envelope as `watch()`. */
import { sleep } from "./util";
import type { ChangeSet, Filters, Row, SheetManager } from "./manager";
import type { Schema } from "./schema";

export interface CacheOptions {
  /** Milliseconds between polls (default 2000). */
  interval?: number;
  filters?: Filters;
  /** Field to key rows on (defaults to the schema's primary key, else whole-row identity). */
  key?: string;
}

export type CacheEvent = "insert" | "update" | "delete" | "change" | "ready" | "sync" | "error";

type Handler = (...args: any[]) => void;

export class SheetCache {
  private manager: SheetManager;
  private interval: number;
  private filters?: Filters;
  private key?: string;
  private snapshot = new Map<unknown, Row>();
  private listeners: Map<CacheEvent, Handler[]> = new Map();
  private controller?: AbortController;
  private task?: Promise<void>;
  private inflight?: Promise<void>;
  private _loaded = false;

  constructor(manager: SheetManager, opts: CacheOptions = {}) {
    this.manager = manager;
    this.interval = opts.interval ?? 2000;
    this.filters = opts.filters;
    this.key = opts.key ?? manager.schema?.primaryKey ?? undefined;
  }

  private _k(row: Row): unknown {
    return this.key ? row[this.key] : JSON.stringify(row);
  }

  /** Subscribe to an event. Returns an unsubscribe function.
   *  `insert`/`delete` → (row); `update` → (row, prev); `change` → (ChangeSet);
   *  `ready` → (rows); `sync` → (rows) after every successful poll, changed or not;
   *  `error` → (err). */
  on(event: "insert" | "delete", handler: (row: Row) => void): () => void;
  on(event: "update", handler: (row: Row, prev: Row | undefined) => void): () => void;
  on(event: "change", handler: (change: ChangeSet) => void): () => void;
  on(event: "ready" | "sync", handler: (rows: Row[]) => void): () => void;
  on(event: "error", handler: (err: unknown) => void): () => void;
  on(event: CacheEvent, handler: Handler): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
    return () => this.listeners.set(event, (this.listeners.get(event) ?? []).filter((h) => h !== handler));
  }

  private _emit(event: CacheEvent, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        handler(...args);
      } catch {
        // A listener must never break the poll loop.
      }
    }
  }

  /** Current cached rows (from the last poll). */
  all(): Row[] {
    return [...this.snapshot.values()];
  }

  /** The cached row for a key value, or undefined. */
  get(key: unknown): Row | undefined {
    return this.snapshot.get(key);
  }

  get size(): number {
    return this.snapshot.size;
  }

  /** True while polling (between `start()` and `stop()`). */
  get running(): boolean {
    return this.controller !== undefined;
  }

  /** True once a snapshot has loaded at least once (it survives `stop()`). */
  get loaded(): boolean {
    return this._loaded;
  }

  /** The schema of the underlying sheet (drives typed rendering in `<SheetTable>`), or undefined. */
  get schema(): Schema | undefined {
    return this.manager.schema;
  }

  /** Read once and diff against the current snapshot, emitting events. `start()` calls this
   *  on the interval; call it yourself to force an immediate refresh. Overlapping calls
   *  share one read — two in-flight reads could otherwise resolve out of order and roll
   *  the snapshot back. */
  refresh(): Promise<void> {
    return (this.inflight ??= this._refresh().finally(() => (this.inflight = undefined)));
  }

  private async _refresh(): Promise<void> {
    const rows = await this.manager.read(this.filters);
    const next = new Map<unknown, Row>(rows.map((r) => [this._k(r), r]));
    const added: Row[] = [];
    const updated: Row[] = [];
    const removed: Row[] = [];
    for (const [k, row] of next) {
      const prev = this.snapshot.get(k);
      if (prev === undefined) {
        added.push(row);
        this._emit("insert", row);
      } else if (JSON.stringify(row) !== JSON.stringify(prev)) {
        updated.push(row);
        this._emit("update", row, prev);
      }
    }
    for (const [k, row] of this.snapshot) {
      if (!next.has(k)) {
        removed.push(row);
        this._emit("delete", row);
      }
    }
    this.snapshot = next;
    this._loaded = true;
    if (added.length || updated.length || removed.length) {
      this._emit("change", { added, updated, removed });
    }
    this._emit("sync", this.all());
  }

  /** Load the initial snapshot (emitting `ready`), then poll for changes in the background.
   *  Resolves once the initial snapshot is loaded. Idempotent. */
  async start(): Promise<this> {
    if (this.controller) return this;
    const controller = new AbortController();
    this.controller = controller;
    let rows: Row[];
    try {
      rows = await this.manager.read(this.filters);
    } catch (e) {
      // Don't leave a half-started cache — a later start() must retry.
      if (this.controller === controller) this.stop();
      throw e;
    }
    // stop() (or stop()+start()) ran while the read was in flight: this call was superseded —
    // don't touch the snapshot or spawn a second poll loop.
    if (controller.signal.aborted) return this;
    this.snapshot = new Map(rows.map((r) => [this._k(r), r]));
    this._loaded = true;
    this._emit("ready", this.all());
    this.task = this._loop(controller.signal);
    return this;
  }

  private async _loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(this.interval, signal);
      if (signal.aborted) break;
      try {
        await this.refresh();
      } catch (e) {
        this._emit("error", e);
      }
    }
  }

  /** Stop polling. The cached snapshot stays readable. */
  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
  }
}

/** Create a reactive cache over a sheet. See {@link SheetCache}. */
export function createCache(manager: SheetManager, opts: CacheOptions = {}): SheetCache {
  return new SheetCache(manager, opts);
}
