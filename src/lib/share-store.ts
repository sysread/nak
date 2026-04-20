/**
 * Cross-context IndexedDB buffer for Web Share Target payloads.
 *
 * The service worker (src/sw.ts) intercepts POST requests to
 * `<scope>share`, pulls the multipart form fields out, and calls
 * `savePendingShare` here before redirecting the user back to the app
 * root with `?share=pending` in the URL. The app — specifically
 * Chat.svelte's onMount — then calls `consumePendingShares` to drain
 * the buffer and feed the content into the composer.
 *
 * IndexedDB is the right transport because:
 *   1. The SW and the app window are different JS realms that can't
 *      share variables — they need a persistent medium to hand off.
 *   2. A share can happen while the app tab is closed; the SW fires,
 *      stores the payload, and the app picks it up whenever the user
 *      next opens Nak (so a share while the app is locked is held
 *      until after the unlock).
 *   3. File payloads are binary; postMessage + Blob works but requires
 *      an already-open client, which we can't assume.
 *
 * The store has a single `by-id` autoincrement keypath so multiple
 * stacked shares (e.g. the user shared twice before opening the app)
 * are preserved in arrival order. Files are persisted as Blobs — IDB
 * supports them natively, no ArrayBuffer round-trip needed.
 *
 * This module deliberately stays free of Svelte / DOM-library imports
 * so it can be loaded from the service worker context without
 * dragging in anything that assumes a window.
 */

const DB_NAME = 'nak-share';
const DB_VERSION = 1;
const STORE = 'pending';

export interface SharedFile {
  name: string;
  type: string;
  /** Raw bytes of the shared file, preserved as-is. */
  blob: Blob;
}

export interface SharedPayload {
  /** Monotonic receive time in ms. Handy for debugging ordering. */
  ts: number;
  /** Share-sheet title field — some apps leave this empty. */
  title: string;
  /** Share-sheet free-form text field. */
  text: string;
  /**
   * Share-sheet URL field. On Android this is populated for link
   * shares from the browser / news readers; on iOS the whole link
   * often comes through as `text` instead, so callers typically treat
   * `text` and `url` interchangeably.
   */
  url: string;
  files: SharedFile[];
}

/** Row as stored in IDB — identical to the payload but with the autoincrement id. */
interface StoredShare extends SharedPayload {
  id?: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error);
  });
}

/**
 * Persist a share payload. Called from the service worker as part of
 * the POST /share handler. Swallows errors into the returned promise
 * so the SW can still redirect the user to the app — losing a share
 * is annoying but losing the whole redirect leaves them staring at
 * the browser's default POST failure page.
 */
export async function savePendingShare(payload: SharedPayload): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error);
      tx.onabort = (): void => reject(tx.error);
      tx.objectStore(STORE).add(payload satisfies StoredShare);
    });
  } finally {
    db.close();
  }
}

/**
 * Drain all pending shares in arrival order and delete them from the
 * store. The drain-and-delete happens in a single readwrite
 * transaction so a second caller racing us (e.g. two tabs both
 * mounting Chat at once) can't produce duplicate composer inserts.
 * Returns an empty array when nothing is queued.
 */
export async function consumePendingShares(): Promise<SharedPayload[]> {
  const db = await openDb();
  try {
    return await new Promise<SharedPayload[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.getAll();
      getReq.onsuccess = (): void => {
        store.clear();
      };
      getReq.onerror = (): void => reject(getReq.error);
      tx.oncomplete = (): void => {
        const rows = (getReq.result as StoredShare[]) ?? [];
        // Strip the internal id before handing rows to callers — it's
        // a storage detail, not part of the SharedPayload contract.
        resolve(
          rows.map(({ ts, title, text, url, files }) => ({
            ts,
            title,
            text,
            url,
            files,
          }))
        );
      };
      tx.onerror = (): void => reject(tx.error);
      tx.onabort = (): void => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
