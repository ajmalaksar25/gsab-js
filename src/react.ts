/** React bindings — a live sheet as a hook, built on `createCache()`.
 *
 *      import { connect } from "gsab-js";
 *      import { useSheet } from "gsab-js/react";
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

import {
  createElement,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";

import { SheetCache, createCache } from "./cache";
import type { CacheOptions } from "./cache";
import { ValidationError } from "./errors";
import type { Row, SheetManager } from "./manager";
import { FieldType } from "./schema";
import type { FieldDef, FieldTypeName, Schema } from "./schema";
import { collectErrors } from "./validate";

/** Loosely-typed createElement — these components build their DOM by hand (no JSX build step). */
const h = createElement as unknown as (type: any, props?: any, ...children: any[]) => ReactNode;

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

// --- schema-driven components ------------------------------------------------
// Define a Schema once, get a wired <SheetForm> and <SheetTable>. Unstyled by design: every
// element carries a `gsab-*` class (override via `classPrefix`) plus data-attributes, so you
// bring the CSS. Experimental — the table's liveness is useSheet()'s polling envelope.

const DEFAULT_PREFIX = "gsab";

/** "firstName" / "created_at" -> "First Name" / "Created At". */
function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function toBool(v: unknown): boolean {
  return typeof v === "boolean" ? v : ["true", "1", "yes"].includes(String(v).trim().toLowerCase());
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Human-readable cell text for the table, by field type. */
function formatCell(value: unknown, type: FieldTypeName | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  switch (type) {
    case FieldType.BOOLEAN:
      return toBool(value) ? "✓" : "✗";
    case FieldType.DATE:
    case FieldType.DATETIME: {
      const d = value instanceof Date ? value : new Date(String(value));
      if (isNaN(d.getTime())) return String(value);
      return type === FieldType.DATE ? d.toLocaleDateString() : d.toLocaleString();
    }
    case FieldType.JSON:
      return typeof value === "string" ? value : JSON.stringify(value);
    default:
      return String(value);
  }
}

/** The form's starting value for a field: an explicit seed, else the schema default, else empty
 *  (unchecked for a boolean). Booleans are coerced so a default of true shows the box checked; a
 *  JSON object seed is pretty-printed so an edit form's textarea shows text, not "[object Object]". */
function initialValueFor(f: FieldDef, seed: unknown): unknown {
  const v = seed !== undefined ? seed : f.default;
  if (f.type === FieldType.BOOLEAN) return toBool(v);
  if (f.type === FieldType.JSON && v !== null && typeof v === "object") return JSON.stringify(v, null, 2);
  return v ?? "";
}

export interface UseSheetFormOptions<T extends Row = Row> {
  /** Schema driving the fields; defaults to the sheet's schema. */
  schema?: Schema;
  /** "insert" appends a new row (default); "upsert" inserts or updates on the key. */
  mode?: "insert" | "upsert";
  /** Which fields to include, in order (defaults to every schema field). */
  fields?: string[];
  /** Seed values, e.g. for an edit form (read once on mount). */
  initialValues?: Partial<T>;
  /** Clear the form after a successful submit (default: true for insert, false for upsert). */
  resetOnSuccess?: boolean;
  onSuccess?: (record: T) => void;
  onError?: (error: unknown) => void;
}

export interface UseSheetFormResult {
  /** Current field values (input strings; booleans for checkboxes). */
  values: Row;
  /** Per-field validation messages from the last submit attempt. */
  errors: Record<string, string>;
  /** A submit-level error (duplicate key, network failure, …), or undefined. */
  error: unknown;
  /** True while a submit is in flight. */
  submitting: boolean;
  /** True after at least one successful submit. */
  submitted: boolean;
  /** The fields being rendered, in order. */
  fields: string[];
  /** The resolved schema. */
  schema: Schema;
  /** Set one field's value. */
  setField: (name: string, value: unknown) => void;
  /** Reset values to the initial seed and clear errors. */
  reset: () => void;
  /** Validate, then insert/upsert. Resolves true on success, false on a validation or write error. */
  submit: () => Promise<boolean>;
}

/** Headless form logic over a SheetManager: values, client-side validation (reusing the schema's
 *  constraints), and insert/upsert on submit. `<SheetForm>` is a thin renderer over this — call
 *  it directly to build a fully custom form. */
export function useSheetForm<T extends Row = Row>(
  sheet: SheetManager,
  opts: UseSheetFormOptions<T> = {},
): UseSheetFormResult {
  const schema = opts.schema ?? sheet.schema;
  if (!schema) {
    throw new ValidationError(
      "useSheetForm needs a schema — pass one to connect(...).sheet(schema) or via { schema }.",
    );
  }
  const mode = opts.mode ?? "insert";
  const seedKey = JSON.stringify(opts.initialValues ?? null);
  const fieldsKey = opts.fields?.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fields = useMemo(
    () => (opts.fields ?? schema.fieldNames).filter((n) => n in schema.fields),
    [schema, fieldsKey],
  );

  const build = useCallback((): Row => {
    const v: Row = {};
    const seed = opts.initialValues as Row | undefined;
    for (const name of schema.fieldNames) v[name] = initialValueFor(schema.fields[name], seed?.[name]);
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, seedKey]);

  const [values, setValues] = useState<Row>(build);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const setField = useCallback((name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const reset = useCallback(() => {
    const fresh = build();
    valuesRef.current = fresh;
    setValues(fresh);
    setErrors({});
    setError(undefined);
  }, [build]);

  const submit = useCallback(async (): Promise<boolean> => {
    const raw = valuesRef.current;
    // Build the record from current values, parsing JSON fields from their textarea string.
    const record: Row = {};
    const jsonErrors: Record<string, string> = {};
    for (const name of schema.fieldNames) {
      const f = schema.fields[name];
      let v = raw[name];
      if (f.type === FieldType.JSON && typeof v === "string" && v.trim() !== "") {
        try {
          v = JSON.parse(v);
        } catch {
          jsonErrors[name] = `Field '${name}' must be valid JSON.`;
        }
      }
      record[name] = v;
    }
    const errs = { ...collectErrors(schema, record), ...jsonErrors };
    setErrors(errs);
    if (Object.keys(errs).length) return false;

    // Drop blank optional fields so the write OMITS them (an empty cell) rather than coercing
    // "" to 0 (number) or '""' (json). Required blanks were already caught above, so this never
    // discards a needed value — it matches calling insert() with those keys omitted.
    for (const k of Object.keys(record)) if (record[k] === "") delete record[k];

    setSubmitting(true);
    setError(undefined);
    try {
      if (mode === "upsert") await sheet.upsert(record);
      else await sheet.insert(record);
      setSubmitted(true);
      if (opts.resetOnSuccess ?? mode === "insert") reset();
      opts.onSuccess?.(record as T);
      return true;
    } catch (e) {
      setError(e);
      opts.onError?.(e);
      return false;
    } finally {
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, schema, mode, reset, opts.resetOnSuccess, opts.onSuccess, opts.onError]);

  return { values, errors, error, submitting, submitted, fields, schema, setField, reset, submit };
}

export interface SheetFieldProps {
  name: string;
  field: FieldDef;
  label: string;
  value: unknown;
  error: string | undefined;
  setValue: (value: unknown) => void;
}

export interface SheetFormProps<T extends Row = Row> extends UseSheetFormOptions<T> {
  /** The sheet to write to (from connect(...).sheet(schema)). */
  sheet: SheetManager;
  /** Submit button text (default "Save"). */
  submitLabel?: string;
  /** Submit button text while writing (default "Saving…"). */
  submittingLabel?: string;
  /** Per-field label override (defaults to a humanized field name). */
  labels?: Record<string, string>;
  /** Class prefix for every element's className (default "gsab"). */
  classPrefix?: string;
  /** Custom field renderer; return null/undefined to fall back to the default input. */
  renderField?: (props: SheetFieldProps) => ReactNode;
}

/** The default input for one field, chosen by its type (number / checkbox / date / textarea / text). */
function defaultField(
  p: string,
  tab: string,
  name: string,
  f: FieldDef,
  label: string,
  value: unknown,
  error: string | undefined,
  setValue: (value: unknown) => void,
): ReactNode {
  const id = `${p}-${tab}-${name}`;
  const required = !!(f.required || f.primaryKey);
  const common: Record<string, unknown> = {
    id,
    name,
    className: `${p}-input`,
    "data-field": name,
    "data-type": f.type,
  };
  const onText = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value);
  const str = (value ?? "") as string;

  let control: ReactNode;
  switch (f.type) {
    case FieldType.INTEGER:
    case FieldType.FLOAT:
      control = h("input", {
        ...common,
        type: "number",
        step: f.type === FieldType.INTEGER ? 1 : "any",
        min: f.minValue,
        max: f.maxValue,
        required,
        value: str,
        onChange: onText,
      });
      break;
    case FieldType.BOOLEAN:
      control = h("input", {
        ...common,
        type: "checkbox",
        checked: toBool(value),
        onChange: (e: ChangeEvent<HTMLInputElement>) => setValue(e.target.checked),
      });
      break;
    case FieldType.DATE:
      control = h("input", { ...common, type: "date", required, value: str, onChange: onText });
      break;
    case FieldType.DATETIME:
      control = h("input", { ...common, type: "datetime-local", required, value: str, onChange: onText });
      break;
    case FieldType.JSON:
      control = h("textarea", { ...common, required, rows: 3, value: str, onChange: onText });
      break;
    default:
      control = h("input", {
        ...common,
        type: "text",
        required,
        minLength: f.minLength,
        maxLength: f.maxLength,
        pattern: f.pattern,
        value: str,
        onChange: onText,
      });
  }

  return h(
    "div",
    { key: name, className: `${p}-field`, "data-field": name },
    h("label", { className: `${p}-label`, htmlFor: id }, required ? `${label} *` : label),
    control,
    error ? h("span", { className: `${p}-error`, role: "alert" }, error) : null,
  );
}

/** A validated, schema-driven form that inserts (or upserts) a row on submit. Give it a sheet
 *  whose schema defines the fields; it renders a typed input per field with client-side
 *  validation, then calls insert()/upsert(). Unstyled — style via the `gsab-*` classes. */
export function SheetForm<T extends Row = Row>(props: SheetFormProps<T>): ReactNode {
  const {
    sheet,
    submitLabel = "Save",
    submittingLabel = "Saving…",
    labels,
    classPrefix = DEFAULT_PREFIX,
    renderField,
    ...formOpts
  } = props;
  const p = classPrefix;
  const form = useSheetForm<T>(sheet, formOpts);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void form.submit();
  };

  const fieldNodes = form.fields.map((name) => {
    const field = form.schema.fields[name];
    const label = labels?.[name] ?? humanize(name);
    const value = form.values[name];
    const err = form.errors[name];
    const setValue = (v: unknown) => form.setField(name, v);
    if (renderField) {
      const custom = renderField({ name, field, label, value, error: err, setValue });
      if (custom !== undefined && custom !== null) {
        return h("div", { key: name, className: `${p}-field`, "data-field": name }, custom);
      }
    }
    return defaultField(p, form.schema.name, name, field, label, value, err, setValue);
  });

  return h(
    "form",
    // noValidate: the schema (via collectErrors) is the single source of truth — native HTML5
    // constraint validation would preempt it and can disagree (unanchored pattern, integer step).
    { className: `${p}-form`, onSubmit, noValidate: true, "data-tab": form.schema.name },
    ...fieldNodes,
    form.error
      ? h("div", { key: "__error", className: `${p}-form-error`, role: "alert" }, messageOf(form.error))
      : null,
    h(
      "button",
      { key: "__submit", type: "submit", className: `${p}-submit`, disabled: form.submitting },
      form.submitting ? submittingLabel : submitLabel,
    ),
  );
}

export interface SheetTableProps<T extends Row = Row> {
  /** Live source: a SheetManager (the table owns the poller) or a shared SheetCache. */
  source: SheetManager | SheetCache;
  /** Columns to show, in order (defaults to the schema's fields, else the first row's keys). */
  columns?: string[];
  /** Per-column header override (defaults to a humanized field name). */
  labels?: Record<string, string>;
  /** Poll options when a SheetManager is passed (interval / filters / key). */
  options?: CacheOptions;
  /** Custom cell renderer; return undefined to fall back to the default formatter. */
  renderCell?: (value: unknown, column: string, row: T) => ReactNode;
  /** Shown when the sheet has no rows (default: "No rows"). */
  empty?: ReactNode;
  /** Class prefix for every element's className (default "gsab"). */
  classPrefix?: string;
}

/** A live table over a sheet: reads via useSheet() and re-renders as rows change. Columns and
 *  cell formatting come from the schema when the source is a typed SheetManager. Unstyled —
 *  style via the `gsab-*` classes. Experimental (polling, not push). */
export function SheetTable<T extends Row = Row>(props: SheetTableProps<T>): ReactNode {
  const { source, columns, labels, options, renderCell, empty, classPrefix = DEFAULT_PREFIX } = props;
  const p = classPrefix;
  const { rows, loading, error } = useSheet<T>(source, options);
  const schema = (source as { schema?: Schema }).schema;
  const cols = columns ?? schema?.fieldNames ?? (rows.length ? Object.keys(rows[0]) : []);
  const keyFor = (row: Row, i: number): string => {
    const pk = schema?.primaryKey;
    const v = pk ? (row as Row)[pk] : undefined;
    return v !== null && v !== undefined && v !== "" ? String(v) : `__row_${i}`;
  };

  return h(
    "div",
    {
      className: `${p}-table-wrap`,
      "data-loading": loading || undefined,
      "data-error": error ? messageOf(error) : undefined,
    },
    h(
      "table",
      { className: `${p}-table` },
      h(
        "thead",
        { key: "head" },
        h(
          "tr",
          null,
          ...cols.map((c) =>
            h("th", { key: c, className: `${p}-th`, "data-field": c }, labels?.[c] ?? humanize(c)),
          ),
        ),
      ),
      h(
        "tbody",
        { key: "body" },
        rows.map((row, i) =>
          h(
            "tr",
            { key: keyFor(row, i), className: `${p}-tr` },
            ...cols.map((c) => {
              const custom = renderCell ? renderCell(row[c], c, row as T) : undefined;
              const content =
                custom !== undefined ? custom : formatCell(row[c], schema?.fields[c]?.type);
              return h("td", { key: c, className: `${p}-td`, "data-field": c }, content);
            }),
          ),
        ),
      ),
    ),
    !loading && !error && !rows.length ? h("div", { className: `${p}-empty` }, empty ?? "No rows") : null,
  );
}
