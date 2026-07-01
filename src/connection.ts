import { ValidationError } from "./errors";
import { SheetManager } from "./manager";
import { normalizeSchema } from "./schema";
import type { Schema, SchemaDef } from "./schema";

/** Supplies a Google OAuth access token, or null for an unauthenticated public read.
 *  Browser (GIS) and Node (loopback) auth both implement this single interface. */
export interface Credentials {
  getToken(): Promise<string | null>;
}

export const PUBLIC: Credentials = { getToken: async () => null };

/** Pull a spreadsheet id out of a full Google Sheets URL, or pass an id straight through. */
export function parseSheetId(urlOrId: string): string {
  const m = urlOrId.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : urlOrId;
}

export interface ConnectOptions {
  spreadsheetId?: string;
  url?: string;
  auth?: Credentials | "public";
}

export class SheetConnection {
  spreadsheetId: string;
  auth: Credentials;

  constructor(opts: string | ConnectOptions) {
    if (typeof opts === "string") {
      this.spreadsheetId = parseSheetId(opts);
      this.auth = PUBLIC;
      return;
    }
    const raw = opts.spreadsheetId ?? opts.url;
    if (!raw) throw new ValidationError("connect() needs a spreadsheetId or url.");
    this.spreadsheetId = parseSheetId(raw);
    this.auth = !opts.auth || opts.auth === "public" ? PUBLIC : opts.auth;
  }

  getToken(): Promise<string | null> {
    return this.auth.getToken();
  }

  /** Bind a tab (optionally typed by a schema) and return a SheetManager. */
  sheet(schema?: Schema | SchemaDef): SheetManager {
    return new SheetManager(this, schema ? normalizeSchema(schema) : undefined);
  }
}
