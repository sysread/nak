/**
 * IndexedDB storage for the offline cache - the durable, per-device
 * mirror of the records the user marked for offline access (favorited
 * wiki articles; favorited or upcoming recipes). Pure bytes in and out:
 * open the DB per call, close it in `finally`, wrap each request in a
 * promise. No application logic lives here - which rows belong in the
 * cache, when to refresh, and when to evict are `offline-sync`'s job.
 *
 * The raw-`indexedDB` style (no `idb` dependency) deliberately mirrors
 * `draft-store.ts` / `share-store.ts`; keep the three consistent.
 *
 * One DB, one object store per kind, `keyPath: 'id'`. A cached entry
 * wraps the full row plus `cachedAt` (wall-clock ms it was written) so
 * a future age-based policy has a timestamp to key on - today nothing
 * expires by clock; eviction is driven entirely by the favorite/upcoming
 * set, not by age.
 */

const DB_NAME = 'nak-offline-cache';
const DB_VERSION = 1;

export type OfflineStoreName = 'articles' | 'recipes';
const STORE_NAMES: readonly OfflineStoreName[] = ['articles', 'recipes'];

export interface CachedEntry<T> {
  /** keyPath - mirrors the row's `id`. */
  id: string;
  /** The full row as fetched from Supabase (already coerced). */
  row: T;
  /** Wall-clock ms the row was written to the cache. */
  cachedAt: number;
}

// IndexedDB is absent in non-browser contexts (the vitest jsdom run
// without a polyfill, an SSR pass) and can throw in hardened private
// modes. Callers treat "unavailable" as "empty cache" rather than
// erroring, so every entry point short-circuits on this guard.
function available(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error);
  });
}

/** Upsert one entry (`put` is insert-or-replace). */
export async function putCached<T>(
  store: OfflineStoreName,
  entry: CachedEntry<T>,
): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error);
      tx.onabort = (): void => reject(tx.error);
      tx.objectStore(store).put(entry);
    });
  } finally {
    db.close();
  }
}

/** Read one entry by id, or null when absent. */
export async function getCached<T>(
  store: OfflineStoreName,
  id: string,
): Promise<CachedEntry<T> | null> {
  if (!available()) return null;
  const db = await openDb();
  try {
    return await new Promise<CachedEntry<T> | null>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(id);
      req.onsuccess = (): void =>
        resolve((req.result as CachedEntry<T> | undefined) ?? null);
      req.onerror = (): void => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Read every entry in a store. */
export async function getAllCached<T>(
  store: OfflineStoreName,
): Promise<CachedEntry<T>[]> {
  if (!available()) return [];
  const db = await openDb();
  try {
    return await new Promise<CachedEntry<T>[]>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = (): void => resolve((req.result as CachedEntry<T>[]) ?? []);
      req.onerror = (): void => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Delete one entry by id (no-op when absent). */
export async function deleteCached(
  store: OfflineStoreName,
  id: string,
): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error);
      tx.onabort = (): void => reject(tx.error);
      tx.objectStore(store).delete(id);
    });
  } finally {
    db.close();
  }
}
