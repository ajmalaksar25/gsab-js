/** gsab — Google Sheets as a Backend (JavaScript / TypeScript client).
 *
 *  No-auth public read tier (browser + Node):
 *      import { connect } from "gsab-js";
 *      const db = connect("https://docs.google.com/spreadsheets/d/<ID>/edit").sheet();
 *      const rows = await db.read({ plan: "pro" });
 *      const top  = await db.query("SELECT A, D ORDER BY D DESC LIMIT 10");
 *      for await (const change of db.watch()) console.log(change);
 */
export { SheetConnection, parseSheetId, PUBLIC } from "./connection";
export type { ConnectOptions, Credentials } from "./connection";
export { SheetManager } from "./manager";
export type { ChangeSet, WatchOptions, Row, Filters, ShareRole } from "./manager";
export { SheetCache, createCache } from "./cache";
export type { CacheOptions, CacheEvent } from "./cache";
export { Schema, FieldType, normalizeSchema } from "./schema";
export type { FieldDef, SchemaDef, FieldTypeName } from "./schema";
export { MemoryTokenStore } from "./store";
export type { TokenStore, StoredCredential } from "./store";
export {
  GSABError,
  AuthError,
  ConnectionError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  ValidationError,
  DuplicateKeyError,
  APIError,
} from "./errors";
export type { GSABErrorOptions } from "./errors";

import { SheetConnection } from "./connection";
import type { ConnectOptions } from "./connection";

/** Open a connection to a spreadsheet.
 *  Pass a URL/id string for a public read, or `{spreadsheetId | url, auth}` for
 *  authenticated access. Call `.sheet(schema?)` on the result to get a SheetManager. */
export function connect(opts: string | ConnectOptions): SheetConnection {
  return new SheetConnection(opts);
}

/** Alias for `connect()` (familiar to supabase-js / convex users). */
export const createClient = connect;
