/**
 * IndexedDB buffer for in-flight streaming completions.
 *
 * When a chat-loop round is underway the streaming text lives only in
 * memory. If the browser tab is closed, the device loses power, or
 * Chrome's background-app freeze kills the page, the partially-generated
 * response is gone. This module persists a rolling snapshot of the
 * accumulating text so the app can surface a recovery prompt on the next
 * open ("previous response was interrupted - retry?").
 *
 * One record per thread, keyed by threadId. The record is created when
 * streaming starts and deleted on any clean completion (success, conflict,
 * interrupted, or error). An un-deleted record on next load means the
 * previous session ended abruptly.
 *
 * This module deliberately stays free of Svelte / DOM-library imports so
 * it is safe to load in any context without side effects.
 */

const DB_NAME = 'nak-drafts';
const DB_VERSION = 1;
const STORE = 'completions';

export interface StreamingDraft {
  /** Thread the draft belongs to - IDB keyPath. */
  threadId: string;
  /**
   * The user message that triggered this completion. Used on recovery
   * to verify that no assistant response has already been committed for
   * this turn (which would mean the stream completed just before the
   * crash and recovery is a no-op).
   */
  userMessageId: string;
  /** Venice model id at the time the turn started. */
  modelId: string;
  /** Accumulated assistant text as of the last flush. */
  text: string;
  /** Accumulated reasoning text as of the last flush. */
  reasoning: string;
  /** Wall-clock ms when streaming started. */
  startedAt: number;
  /** Wall-clock ms of the last flush. */
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'threadId' });
      }
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error);
  });
}

/** Create or overwrite the draft record for a thread. Called once at turn start. */
export async function saveDraft(draft: StreamingDraft): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error);
      tx.onabort = (): void => reject(tx.error);
      tx.objectStore(STORE).put(draft);
    });
  } finally {
    db.close();
  }
}

/**
 * Flush the latest accumulated text + reasoning into the existing record.
 * Called on each display-flush tick (~500ms). Silently no-ops if the record
 * doesn't exist (e.g. openDb failed on the initial saveDraft).
 */
export async function updateDraftText(
  threadId: string,
  text: string,
  reasoning: string
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(threadId);
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error);
      tx.onabort = (): void => reject(tx.error);
      getReq.onsuccess = (): void => {
        const existing = getReq.result as StreamingDraft | undefined;
        if (!existing) return; // record gone or never written - skip
        store.put({ ...existing, text, reasoning, updatedAt: Date.now() });
      };
    });
  } finally {
    db.close();
  }
}

/** Remove the draft for a thread. Called on any clean completion. */
export async function deleteDraft(threadId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error);
      tx.onabort = (): void => reject(tx.error);
      tx.objectStore(STORE).delete(threadId);
    });
  } finally {
    db.close();
  }
}

/**
 * Load the draft for a thread, or null if none exists.
 * Called after messages load to detect orphaned completions.
 */
export async function loadDraft(threadId: string): Promise<StreamingDraft | null> {
  const db = await openDb();
  try {
    return await new Promise<StreamingDraft | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(threadId);
      req.onsuccess = (): void =>
        resolve((req.result as StreamingDraft | undefined) ?? null);
      req.onerror = (): void => reject(req.error);
    });
  } finally {
    db.close();
  }
}
