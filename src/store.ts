/** Pluggable per-user credential storage for multi-tenant auth (see `createUserAuth` in
 *  `gsab-js/node`). The interface is platform-neutral — back it with a database, a KV store,
 *  a `users` sheet, or the in-memory default below. Only the refresh token is required;
 *  clientId/clientSecret may be stored per-user when users authorize different OAuth clients,
 *  otherwise the shared app client is used. */
export interface StoredCredential {
  /** The user's long-lived Google refresh token. */
  refreshToken: string;
  /** OAuth client id, if this user authorized under a client other than the app default. */
  clientId?: string;
  /** OAuth client secret paired with `clientId`. */
  clientSecret?: string;
}

/** A key/value store of `StoredCredential` keyed by your own user id. Methods may be sync or
 *  async. `delete` is optional (used to evict a revoked user). */
export interface TokenStore {
  get(userId: string): Promise<StoredCredential | null> | StoredCredential | null;
  set(userId: string, cred: StoredCredential): Promise<void> | void;
  delete?(userId: string): Promise<void> | void;
}

/** In-memory `TokenStore` — fine for a single long-lived process or tests; nothing survives a
 *  restart. Back a real deployment with a persistent store. */
export class MemoryTokenStore implements TokenStore {
  private map = new Map<string, StoredCredential>();
  get(userId: string): StoredCredential | null {
    return this.map.get(userId) ?? null;
  }
  set(userId: string, cred: StoredCredential): void {
    this.map.set(userId, cred);
  }
  delete(userId: string): void {
    this.map.delete(userId);
  }
}
