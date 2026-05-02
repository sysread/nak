/**
 * Biometric unlock for the master password.
 *
 * The master password derives the AES-GCM key that decrypts
 * `nak:config:v1` (see `./crypto.ts` and `./config.ts`). Typing it on
 * a phone is friction the user wants to skip when their device already
 * gates access via TouchID / FaceID / fingerprint. Biometric unlock
 * here is a wrapper over the existing password path: a device-bound
 * passkey re-produces the master password on demand, which is then
 * fed into the unchanged `loadConfig(password)` flow.
 *
 * # Security construction
 *
 * Naive "WebAuthn-as-a-gate" (call `credentials.get`, then read a
 * plaintext password from IndexedDB) is just window dressing - an
 * attacker who can read the storage just reads the password. We use
 * the WebAuthn PRF extension instead. PRF asks the authenticator to
 * compute HMAC over (a credential-bound key, a salt) and return the
 * result. The credential-bound key never leaves the secure enclave /
 * TPM / Android StrongBox, and the HMAC only runs after a successful
 * `userVerification: 'required'` gesture (biometric or device PIN).
 * We use the PRF output as an AES-GCM key to encrypt the master
 * password; the ciphertext lives in localStorage. Without the device
 * AND a passing biometric/PIN gesture, an attacker holding the raw
 * storage cannot derive the key.
 *
 * # Browser support
 *
 * PRF is in Chrome 113+, Edge 113+, Safari 18 (iOS 18 / macOS 15)+,
 * and recent Firefox. We feature-detect at enrollment: if the
 * authenticator does not report `extensions.prf.enabled`, we abort
 * the enrollment and never persist a blob - the user is told the
 * platform does not support biometric unlock and falls back to
 * typing the password as before.
 *
 * # Key rotation
 *
 * Changing the master password invalidates whatever string this
 * module re-produces. The Security pane in Settings calls
 * `clearBiometric()` after a successful `changePassword`, so the
 * user is prompted to re-enroll if they want biometric unlock under
 * the new password. We could re-encrypt transparently, but that
 * requires running the biometric gesture during the rotation flow,
 * which is a UX surprise. Wiping is simpler and safer.
 */

import { createLogger } from './logger.svelte';

const log = createLogger('biometric');

const STORAGE_KEY = 'nak:biometric:v1';

// PRF input salt. Stable per-enrollment - regenerated whenever we
// register a new credential. The salt distinguishes this app's PRF
// derivation from any other app the same authenticator might service.
const SALT_BYTES = 32;

// Local-storage envelope for the wrapped password. Versioned so we
// can evolve the layout (e.g. switch wrap algorithms) without
// silently misreading old blobs.
interface StoredEnvelope {
  v: 1;
  // base64url encoding of the WebAuthn credential ID. We hand this
  // back as `allowCredentials` so the user is prompted for the right
  // passkey rather than seeing a picker.
  credentialId: string;
  // base64 encoding of the PRF salt.
  salt: string;
  // base64 encoding of the AES-GCM IV used to wrap the password.
  iv: string;
  // base64 encoding of the AES-GCM ciphertext+tag of the master
  // password (UTF-8).
  ciphertext: string;
}

const IV_BYTES = 12;

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return b64decode(padded);
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * True when the platform exposes WebAuthn AND a built-in user-
 * verifying authenticator (TouchID, Windows Hello, Android
 * fingerprint, etc.). PRF support itself is verified at enrollment;
 * we cannot probe it without making a credential. This call is the
 * gate the Settings UI uses to decide whether to show the toggle at
 * all.
 */
export async function isBiometricSupported(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (typeof PublicKeyCredential === 'undefined') return false;
  // Cross-platform authenticators (security keys, phone-as-authenticator)
  // exist, but the UX promise here is "the biometric gate built into
  // your device". Insisting on a platform authenticator avoids the
  // user pairing a security key just to skip a typed password.
  try {
    const available =
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    return available === true;
  } catch {
    return false;
  }
}

/**
 * Synchronous "is there a wrapped password sitting in localStorage?"
 * check. Used by the Unlock screen to decide whether to show the
 * "Use biometric" button on first paint.
 */
export function isBiometricEnrolled(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    return storage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function clearBiometric(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Best effort: localStorage can throw under quota / privacy
    // policies. The on-disk blob will be re-overwritten or ignored
    // on next enrollment.
  }
}

function readEnvelope(): StoredEnvelope | null {
  const storage = getStorage();
  if (!storage) return null;
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      parsed.v === 1 &&
      typeof parsed.credentialId === 'string' &&
      typeof parsed.salt === 'string' &&
      typeof parsed.iv === 'string' &&
      typeof parsed.ciphertext === 'string'
    ) {
      return parsed as StoredEnvelope;
    }
  } catch {
    // Fall through - corrupted JSON drops to "not enrolled".
  }
  return null;
}

function writeEnvelope(env: StoredEnvelope): void {
  const storage = getStorage();
  if (!storage) throw new Error('localStorage is not available.');
  storage.setItem(STORAGE_KEY, JSON.stringify(env));
}

/**
 * Convert the 32-byte PRF output into an AES-GCM CryptoKey. The PRF
 * output is already 256 bits of high-entropy material derived from
 * the credential-bound key, so we import it raw; no extra KDF step
 * is needed.
 */
async function prfOutputToAesKey(prf: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    prf,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Pull the PRF eval result out of a credential's
 * clientExtensionResults. Browsers return it under either
 * `prf.results.first` (current spec) - older Chrome shipped a slightly
 * different shape, but every browser that supports PRF today returns
 * the spec'd path. Returns null if PRF was not honored.
 */
function readPrfFirst(cred: PublicKeyCredential): ArrayBuffer | null {
  const ext = cred.getClientExtensionResults() as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
  };
  return ext?.prf?.results?.first ?? null;
}

/**
 * Human-readable summary of the prf field of a credential's
 * clientExtensionResults. Surfaced in failure messages so a user
 * who hits "no PRF result" can tell us whether the authenticator
 * ack'd PRF (`enabled: true`) but refused to compute it, or whether
 * it dropped the extension entirely (no prf field at all). The two
 * have very different remediations.
 */
function summarizePrf(cred: PublicKeyCredential): string {
  const ext = cred.getClientExtensionResults() as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer; second?: ArrayBuffer } };
  };
  if (!ext) return 'no extension results';
  if (!ext.prf) return 'prf: undefined (extension was dropped)';
  const parts: string[] = [];
  if ('enabled' in ext.prf) parts.push(`enabled=${String(ext.prf.enabled)}`);
  if (ext.prf.results) {
    const f = ext.prf.results.first;
    parts.push(`first=${f instanceof ArrayBuffer ? `${f.byteLength}B` : 'missing'}`);
  } else {
    parts.push('results=undefined');
  }
  return `prf: { ${parts.join(', ')} }`;
}

interface RegistrationExtensions {
  // PRF extension on create() takes an empty input - we only want
  // to enable it; the actual eval happens on the follow-up get().
  // See enrollBiometric for the rationale.
  prf: Record<string, never>;
}

interface AssertionExtensions {
  prf: { eval: { first: ArrayBuffer } };
}

/**
 * Register a platform passkey, evaluate the PRF extension at
 * registration time, and use that PRF output to wrap the supplied
 * master password under AES-GCM. The wrapped blob plus the credential
 * ID and salt are written to localStorage; the password itself is
 * never persisted in the clear.
 *
 * Throws if:
 *   - the platform refuses the registration (user cancelled, no
 *     authenticator, etc.) - error surfaced verbatim;
 *   - the authenticator did not return a PRF result, meaning either
 *     PRF is not supported or the platform requires evaluating PRF
 *     during a separate `get` step. We surface a friendly error and
 *     do NOT persist anything.
 *
 * Caller is expected to have just verified `password` against
 * `loadConfig` so we know it actually decrypts the config.
 */
export async function enrollBiometric(password: string): Promise<void> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Master password is required to enroll biometric unlock.');
  }
  if (!(await isBiometricSupported())) {
    throw new Error('Biometric unlock is not supported on this device.');
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  // user.id MUST be a random per-enrollment buffer, NOT a deterministic
  // string. Credential providers (notably Bitwarden's Android passkey
  // provider) use user.id as a primary key to distinguish accounts on
  // the RP. A fixed user.id across re-enrollments collides with prior
  // entries: the provider may skip the actual passkey creation, save
  // the form-typed master password as a regular password entry, and
  // return an empty / invalid response that produces empty
  // clientExtensionResults. The passkey-prf-playground reference
  // implementation uses 64 random bytes per registration; we match.
  // Cost: re-enrolling leaves an orphaned passkey entry in the user's
  // provider that they can clean up manually.
  const userId = crypto.getRandomValues(new Uint8Array(64));
  // Challenge for create() is required by the spec. No verification
  // path uses it (we are not validating attestation), so a fresh
  // random buffer suffices.
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge,
    // rp.id MUST be set explicitly to the page hostname for Android
    // Chrome to accept the request. Chrome on desktop will derive it
    // implicitly from the origin if omitted, but Chrome on Android
    // (via Credential Manager) refuses to register without an
    // explicit id and the provider may silently drop extensions.
    rp: { name: 'Nak', id: window.location.hostname },
    user: {
      id: userId,
      // Credential providers display user.name as the entry's
      // "username" in their passkey-list UI. "Nak master password"
      // shown as a username reads as nonsense; the master password
      // string itself never goes here. Stick to a short identifier.
      name: 'Nak',
      displayName: 'Nak',
    },
    // ES256 + RS256 covers every platform authenticator we care
    // about. We do not actually consume the public key (no
    // server-side attestation check), so the algorithm only matters
    // insofar as the authenticator must support it.
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      // residentKey: 'required' creates a discoverable credential
      // (resident key on the authenticator, named entry in the
      // user's passkey manager UI). 'discouraged' previously let
      // the authenticator decide and Android Credential Manager
      // returned wildly inconsistent behavior including silently
      // dropping the prf extension. The passkey-prf-playground
      // reference implementation also uses 'required' and is the
      // only configuration that produces PRF output reliably on
      // Chrome/Android with Bitwarden / Google Password Manager.
      // The cost of resident is one slot on the authenticator,
      // which every modern platform authenticator has plenty of.
      residentKey: 'required',
    },
    timeout: 60_000,
    // No `attestation` field. The passkey-prf-playground reference
    // omits it (defaults to 'none' per spec). Setting it explicitly
    // shouldn't change behavior, but we match the playground exactly
    // to rule it out.
    // PRF on create() is just `{}` - enable the extension, do not
    // ask for an inline eval. Passing `{ eval: { first: salt } }`
    // here is spec-legal but Chrome on Android (and some other
    // implementations) silently drops the entire prf extension
    // when it can't perform inline evaluation, returning an empty
    // clientExtensionResults dictionary instead of `enabled: true`.
    // Empty `{}` matches the passkey-prf-playground pattern and
    // works across iOS Safari 18+, Chrome desktop, Edge, and
    // Chrome Android. The actual PRF evaluation always happens on
    // the follow-up get() below.
    extensions: {
      prf: {},
    } as unknown as RegistrationExtensions,
  };

  const cred = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!cred) {
    throw new Error('Biometric enrollment was cancelled.');
  }

  log.debug('credential created', {
    summary: summarizePrf(cred),
  });

  // Brief delay before the follow-up get(). The playground does this
  // with a 500ms setTimeout and the comment "Give a small delay to
  // ensure the credential is fully registered." On some Android +
  // Credential Manager + provider stacks, calling get() immediately
  // after create() races the credential's storage write on the
  // provider side and the get() lookup misses (or returns a
  // degenerate response with stripped extensions). Cheap insurance.
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  // Always do a follow-up get() to harvest the PRF output. Per the
  // WebAuthn PRF spec the create() call only signals support
  // (`prf.enabled`); the actual hmac-secret evaluation happens
  // during the assertion. Two prompts on enrollment, one on every
  // subsequent unlock - the predictable cross-platform pattern.
  log.debug('running get() to evaluate PRF');
  const getChallenge = crypto.getRandomValues(new Uint8Array(32));
  const got = (await navigator.credentials.get({
    publicKey: {
      challenge: getChallenge,
      // rp.id is implicit on get() - we look up by credential id.
      // Wrap in Uint8Array even though rawId is already an
      // ArrayBuffer; some implementations narrow `id: BufferSource`
      // and the Uint8Array path is the well-trodden one (the
      // playground decodes from base64 to Uint8Array and works).
      allowCredentials: [
        {
          id: new Uint8Array(cred.rawId),
          type: 'public-key',
        },
      ],
      userVerification: 'required',
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: salt as BufferSource } },
      } as unknown as AssertionExtensions,
    },
  })) as PublicKeyCredential | null;
  if (!got) throw new Error('Biometric enrollment was cancelled.');
  const prfOutput = readPrfFirst(got);
  if (!prfOutput) {
    const createSummary = summarizePrf(cred);
    const getSummary = summarizePrf(got);
    // Diagnostic dump into the in-app Logs drawer (left panel,
    // gated on the Appearance pane's Default log level). Mobile
    // users without a USB-tethered DevTools session can read this
    // directly off the device. Quiet on the happy path; only
    // fires on this exact failure.
    log.warn('PRF result missing on get()', {
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a',
      createExt: cred.getClientExtensionResults(),
      getExt: got.getClientExtensionResults(),
    });
    throw new Error(
      'Biometric unlock could not be enabled: the credential provider ' +
        'did not return a PRF result. This usually means the provider ' +
        'or device authenticator does not implement the WebAuthn PRF ' +
        'extension yet. ' +
        `(Diagnostic: register=${createSummary}; verify=${getSummary}.)`,
    );
  }

  const aesKey = await prfOutputToAesKey(prfOutput);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      aesKey,
      new TextEncoder().encode(password) as BufferSource,
    ),
  );

  writeEnvelope({
    v: 1,
    credentialId: b64urlEncode(new Uint8Array(cred.rawId)),
    salt: b64encode(salt),
    iv: b64encode(iv),
    ciphertext: b64encode(ciphertext),
  });
}

/**
 * Run the biometric assertion and return the master password. On
 * success the caller has the same string the user would have typed
 * into the Unlock screen; feed it into `loadConfig(password)` to
 * complete the unlock.
 *
 * Throws if there is no enrollment, if the user cancels the
 * biometric prompt, or if the assertion succeeds but PRF was not
 * evaluated (which would imply the authenticator stopped honoring
 * PRF since enrollment - extremely unusual, but we treat it as a
 * hard error rather than silently falling back to typed password).
 */
export async function unlockWithBiometric(): Promise<string> {
  const env = readEnvelope();
  if (!env) {
    throw new Error('Biometric unlock is not enrolled on this device.');
  }
  if (!(await isBiometricSupported())) {
    // The user enrolled, then either changed browsers, cleared the
    // platform authenticator, or moved to a device that does not
    // expose one. Surface a friendly error rather than letting the
    // assertion call fail with a cryptic message.
    throw new Error('Biometric unlock is not available on this device.');
  }

  const salt = b64decode(env.salt);
  const credentialIdBytes = b64urlDecode(env.credentialId);
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const got = (await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [
        {
          id: credentialIdBytes as BufferSource,
          type: 'public-key',
        },
      ],
      userVerification: 'required',
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: salt as BufferSource } },
      } as unknown as AssertionExtensions,
    },
  })) as PublicKeyCredential | null;
  if (!got) {
    throw new Error('Biometric unlock was cancelled.');
  }

  const prfOutput = readPrfFirst(got);
  if (!prfOutput) {
    throw new Error(
      'Biometric assertion succeeded but the device did not return a PRF ' +
        'result. Disable and re-enable biometric unlock in Settings.',
    );
  }

  const aesKey = await prfOutputToAesKey(prfOutput);
  const iv = b64decode(env.iv);
  const ciphertext = b64decode(env.ciphertext);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      aesKey,
      ciphertext as BufferSource,
    );
  } catch {
    // Tag mismatch means the wrapped password no longer matches what
    // the PRF derives - usually because the user cleared the
    // platform authenticator and a fresh credential collides. The
    // envelope is dead; clear it so the next attempt drops back to
    // the typed-password path cleanly.
    clearBiometric();
    throw new Error(
      'Biometric unlock blob is no longer decryptable. Re-enable biometric ' +
        'unlock in Settings after typing your master password.',
    );
  }
  return new TextDecoder().decode(plain);
}

export const __test = {
  STORAGE_KEY,
  SALT_BYTES,
  IV_BYTES,
};
