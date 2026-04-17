import type { AppConfig } from './config';

/**
 * Ephemeral "remember me" store for the decrypted config. Persists through
 * page refreshes within the same tab, but clears when the tab is closed
 * (sessionStorage semantics) and after an inactivity timeout.
 *
 * Storing plaintext here is no worse than the runtime memory exposure that
 * already exists while the app is unlocked — any script running in this
 * origin can read either. The incremental tradeoff is that a refresh
 * within the inactivity window will auto-unlock instead of reprompting
 * for the master password.
 */

const KEY = 'nak:session:v1';

// Default 1 hour of inactivity before auto-lock.
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface SessionBlob {
  config: AppConfig;
  /** Epoch ms at which this session is no longer valid. */
  expiresAt: number;
  /** UUID of the thread the user last had open. Restored on reload. */
  activeThreadId?: string;
}

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

export function saveSession(config: AppConfig, ttlMs: number = DEFAULT_TTL_MS): void {
  const s = storage();
  if (!s) return;
  const blob: SessionBlob = {
    config,
    expiresAt: Date.now() + ttlMs,
  };
  try {
    s.setItem(KEY, JSON.stringify(blob));
  } catch {
    // Quota or private-mode failure — treat as no-op.
  }
}

export function loadSession(): AppConfig | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(KEY);
  if (!raw) return null;
  try {
    const blob = JSON.parse(raw) as SessionBlob;
    if (typeof blob.expiresAt !== 'number' || Date.now() >= blob.expiresAt) {
      s.removeItem(KEY);
      return null;
    }
    return blob.config;
  } catch {
    s.removeItem(KEY);
    return null;
  }
}

export function touchSession(ttlMs: number = DEFAULT_TTL_MS): void {
  const s = storage();
  if (!s) return;
  const raw = s.getItem(KEY);
  if (!raw) return;
  try {
    const blob = JSON.parse(raw) as SessionBlob;
    blob.expiresAt = Date.now() + ttlMs;
    s.setItem(KEY, JSON.stringify(blob));
  } catch {
    // Malformed blob — drop it.
    s.removeItem(KEY);
  }
}

export function clearSession(): void {
  const s = storage();
  if (!s) return;
  s.removeItem(KEY);
}

/**
 * Read the persisted active-thread id, if any. Returns null when there's
 * no session, no saved id, or the session has expired (matches loadSession).
 */
export function getSessionThreadId(): string | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(KEY);
  if (!raw) return null;
  try {
    const blob = JSON.parse(raw) as SessionBlob;
    if (typeof blob.expiresAt !== 'number' || Date.now() >= blob.expiresAt) {
      return null;
    }
    return typeof blob.activeThreadId === 'string' ? blob.activeThreadId : null;
  } catch {
    return null;
  }
}

/**
 * Persist the active-thread id onto the existing session blob. No-op if
 * there's no session (nothing to attach it to). Passing null clears the
 * stored id without touching the rest of the session.
 */
export function setSessionThreadId(id: string | null): void {
  const s = storage();
  if (!s) return;
  const raw = s.getItem(KEY);
  if (!raw) return;
  try {
    const blob = JSON.parse(raw) as SessionBlob;
    if (id === null) delete blob.activeThreadId;
    else blob.activeThreadId = id;
    s.setItem(KEY, JSON.stringify(blob));
  } catch {
    // Malformed — leave it alone so session.ts's other paths can clean up.
  }
}

/**
 * Returns the time-to-expiry in ms, or null if there's no session. Useful
 * for scheduling the next auto-lock check.
 */
export function sessionRemainingMs(): number | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(KEY);
  if (!raw) return null;
  try {
    const blob = JSON.parse(raw) as SessionBlob;
    const remaining = blob.expiresAt - Date.now();
    return remaining > 0 ? remaining : 0;
  } catch {
    return null;
  }
}

export const __test = { KEY };
