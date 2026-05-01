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

interface RegistrationExtensions {
  prf: { eval: { first: ArrayBuffer } };
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
  // userHandle is opaque to the RP but must be present and stable
  // per "user". A single Nak install only has one master password,
  // so a deterministic ID derived from origin is fine; a random
  // 16-byte ID would be equally fine.
  const userId = new TextEncoder().encode('nak-master');
  // Challenge for create() is required by the spec. No verification
  // path uses it (we are not validating attestation), so a fresh
  // random buffer suffices.
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge,
    rp: { name: 'Nak' },
    user: {
      id: userId,
      name: 'Nak master password',
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
      // Discoverable credentials would let a fresh browser find the
      // passkey without us holding the credential ID, but they also
      // burn a "resident key" slot on the authenticator. We keep
      // the credential ID locally and look it up via
      // allowCredentials; resident is unnecessary.
      residentKey: 'discouraged',
      requireResidentKey: false,
    },
    timeout: 60_000,
    attestation: 'none',
    extensions: {
      prf: { eval: { first: salt as BufferSource } },
    } as unknown as RegistrationExtensions,
  };

  const cred = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!cred) {
    throw new Error('Biometric enrollment was cancelled.');
  }

  // Some browsers (Safari 18 in particular) do NOT evaluate PRF on
  // create(); they only return `prf.enabled: true` and require a
  // follow-up get() to actually compute the output. Try the inline
  // path first; fall back to a get() if needed.
  let prfOutput = readPrfFirst(cred);
  if (!prfOutput) {
    const ext = cred.getClientExtensionResults() as {
      prf?: { enabled?: boolean };
    };
    if (!ext?.prf?.enabled) {
      throw new Error(
        'This device registered a passkey but does not support the PRF ' +
          'extension that biometric unlock relies on. Biometric unlock is ' +
          'unavailable here.',
      );
    }
    // Run a get() right away to harvest the PRF output. The user
    // sees a second biometric prompt during enrollment - acceptable
    // one-time cost on Safari; never repeats on subsequent unlocks.
    const getChallenge = crypto.getRandomValues(new Uint8Array(32));
    const got = (await navigator.credentials.get({
      publicKey: {
        challenge: getChallenge,
        allowCredentials: [
          {
            id: cred.rawId,
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
    prfOutput = readPrfFirst(got);
    if (!prfOutput) {
      throw new Error(
        'This device did not return a PRF result. Biometric unlock cannot ' +
          'be enabled here.',
      );
    }
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
