# Planned changes

Deferred feature work that we tried and reverted, or scoped out and
haven't started yet. Each entry captures enough context that the
next session can pick it up cleanly without redoing the dead-end
investigation that got it here.

The bar for an entry: the work must have actual context worth
preserving. A trivial idea ("add a button") doesn't belong here -
just file an issue. This doc is for the cases where we burned real
investigation cycles and the lessons learned are worth saving.

## Contents

- [Retire the browser supervisor](#retire-the-browser-supervisor)
  (shipped 2026-06-11 as item C1 of the de-browser-background-jobs
  milestone; analysis kept here as the historical record)
- [Biometric unlock for the master password](#biometric-unlock-for-the-master-password)
  (obsolete - the master-password layer was removed; kept as WebAuthn PRF reference)

## Retire the browser supervisor

**Status:** shipped - implemented 2026-06-11 as item C1 of the
de-browser-background-jobs milestone, on the
`claude/reorganize-the-workshop` branch. (That milestone's in-progress
design doc was retired once it closed; the current background-job model
lives in [architecture.md](./architecture.md) under "Background-job
model", and git preserves the migration narratives.) The five
units now run in the venice function off the chat-turn tail and the
hourly curation sweep; the browser supervisor and its lease
apparatus are deleted. The analysis below stands as the historical
record of the scoping (2026-06-10) - note its per-agent verdicts
were later overtaken: bias (C2) and samskara (C3) shipped
server-side in the same milestone, and only intuition remains
browser-side, as ongoing-chat-scoped work. Output of the no-tool agents
re-inspection the reorganize-the-workshop plan mandated after its
Phase 3 closed. The re-inspection covered all
eight plain-completion agents; this entry records the verdicts and
the follow-on project they point at.

### The structural finding

The dispatcher migration quietly created a gap for two of the
supervisor's units. `memory_topics` and `recipe_topics` drain queues
whose **writers are now all server-side**: reflection / rem /
deep-sleep write and rewrite memories on cron and chat-turn tails,
and the `recipe_*` tools dispatch in the venice function. A rem
consolidation at 3am rewrites a memory's label and data, the
`clear_memory_topics_on_change` trigger nulls its tags, and the row
then sits untagged until a browser tab happens to be open - the only
thing that drains the queue is the supervisor web worker. Before the
migration, writers and tagger lived in the same browser session, so
the coupling was invisible. Now it is a server-writes/browser-drains
split, and the topic tags feed the TopicsFilter dropdowns. This is
the one place the re-inspection found a browser-only assumption that
has actually become an anti-pattern rather than just overhead.

### Per-agent verdicts

- **auto_title, summary, topics** (thread-shaped units): port
  justified, reflection precedent applies directly. The work is
  created by a completed chat turn, so the turn's `waitUntil` tail
  is the natural trigger - title/summary/tags land seconds after the
  turn instead of whenever the supervisor rotates, and work created
  by a send-and-close-the-tab turn still gets done. UX note that is
  load-bearing: titles currently appear fast because the supervisor
  runs locally; a cron-only port would lag the title of a brand-new
  conversation by up to the cron interval. Tail placement is not
  optional for auto_title. The existing per-row claim RPCs stay as
  the whole mutual exclusion (reflection proved no lease is needed);
  the save RPCs need the b-strict `p_user_id` overload treatment.
- **memory_topics, recipe_topics**: port justified AND closes the
  structural gap above. Cron-sweep shape, a librarian clone minus
  the toolbox: global SECURITY DEFINER claim, one completion,
  guarded save. These two cannot ride a turn tail - their work
  supply is not chat turns.
- **The payoff for doing all five together**: the supervisor web
  worker, its manager, the `nak:supervisor-worker` Web Lock, the
  `worker_leases` supervisor partition, the heartbeat, and the
  session-token postMessage forwarding all become deletable. That
  apparatus exists only to amortize browser-side lease overhead
  across five units; server-side, the per-row claim RPCs are the
  mutual exclusion and the apparatus has no job. Porting a subset
  keeps the apparatus alive for the remainder - all-or-nothing is
  the economical shape.
- **bias**: portable with the fleet pattern (lease becomes cron,
  per-thread claim RPCs stay, aggregate throttle becomes the cron
  cadence the way the fleets' did), medium cost. Two real design
  questions: the active-conversation exclusion set is postMessage'd
  live from the main thread (server equivalent would be
  recency-based exclusion - "updated in the last N minutes" - which
  is arguably better semantics than "open in some tab"), and the
  in-memory aggregate dirty/throttle state needs a home. No
  urgency: bias's work supply is browser-generated chat activity,
  so there is no server-writes/browser-drains gap, just lease
  overhead. Optional follow-on, not part of the supervisor
  retirement.
- **intuition**: NOT a fleet candidate; no action. It is
  turn-latency-coupled, not background: it runs inside the chat
  loop (`Promise.all` with context-recall, bounded by the slower of
  the two), reads the live samskara mood rune and the in-memory
  history array, and writes an ephemeral think block into the
  request. Migrating it means folding it into `/stream`'s prompt
  composition alongside `context-recall/gather.ts` - the same
  "optionally fold into /stream later" project the workshop plan
  already names for gather, and a different project from any fleet
  port. Revisit only if that consolidation happens.
- **samskara**: leave browser-side for now. An 8-phase round-robin
  worker with in-memory per-phase throttles and variable backoff,
  mint toasts via postMessage -> CustomEvent, and tier-2 compound
  machinery that is weeks old (its two new schema functions still
  owe the manual SQL exercise the upstream commit asked for). The
  port shape, if ever: one cron tick = one rotation through the
  phases, the cron interval replacing the in-memory throttles, and
  a realtime insert subscription on `samskaras` replacing the mint
  postMessage (the relay pattern now exists three times over). High
  cost, moderate value - the feature is consumed in-session, so
  closed-tab catch-up buys little. Revisit after tier-2 bakes.

### Recommendation

One follow-on project: **port the five supervisor units and delete
the supervisor** - tail-trigger for the three thread-shaped units
plus cron sweeps for the two tag queues, in whatever PR batching
makes sense at build time. Bias is an optional later port on the
same pattern. Intuition and samskara stay browser-side with no open
question. Per the project's planning rhythm, target-state design
beyond this paragraph is deliberately deferred to whenever this
becomes the active milestone.

## Biometric unlock for the master password

> **Obsolete (2026-06).** This feature existed to unlock the
> master-password / AES-GCM encrypted config blob, which has since
> been removed. The local config is now plaintext (Supabase URL +
> publishable key, both non-secret by design) and the Venice key
> lives server-side in `app_config`, so there is no longer a
> browser-side secret for a biometric gesture to gate - the feature
> as specified has no target. The integration points named below
> (`nak:config:v1`, `changePassword`, `Unlock.svelte`,
> `EditConfig.svelte`) no longer exist. Everything from "Threat
> model and primitive" onward is preserved purely as a WebAuthn PRF
> reference: the lessons learned, the playground patterns, and the
> failure-mode table are reusable if a future feature ever needs a
> device-bound secret in the browser.

**Status:** attempted, reverted on a working tree at commit
`c09a43c` (2026-05-01). PRF could not be made to work on the test
device (Pixel 9 Pro XL, Android 15, Chrome 147, Bitwarden
default + Google Password Manager fallback). Code path was
correct; device-side PRF stack returned empty
`clientExtensionResults` regardless of provider routing.

### Goal

Replace the typed master-password unlock on mobile with a single
biometric / device-PIN gesture, when the user opts in via Settings
-> Security. Keep the typed-password path as the fallback.

### Threat model and primitive

The master password derives the AES-GCM key for the encrypted
config blob (`localStorage['nak:config:v1']`). Biometric unlock
must re-produce that password without weakening the existing
posture.

Plain "WebAuthn-as-a-gate" (call `credentials.get`, then read a
plaintext password from storage) is cosmetic - anyone with
localStorage access bypasses it by reading the password
directly. The right primitive is the **WebAuthn PRF
(Pseudorandom Function) extension**:

- A platform passkey is registered via `credentials.create`.
- A salted `prf.eval` on a follow-up `credentials.get` returns 32
  bytes of HMAC-derived material from a credential-bound key
  that lives inside the device's secure element.
- That 32-byte output becomes an AES-GCM key that wraps the
  master password.
- The wrap (plus credential id and salt) goes into
  `localStorage['nak:biometric:v1']`.

PRF only computes after a successful
`userVerification: 'required'` gesture (TouchID / FaceID /
Windows Hello / Android fingerprint / device PIN). Without
both the device AND a passing biometric gesture, an attacker
holding the raw storage cannot unwrap the password.

### What was tried and reverted

Implementation across `src/lib/biometric.ts`, the Settings
Security pane, and `Unlock.svelte` (auto-trigger on mount, fall
back to typed password on cancel). Also touched
`EditConfig.svelte` to clear biometric on Reset.

The implementation went through six debugging rounds chasing
PRF failures on the test device:

1. First-pass: enrollment failed with "this device does not
   support the PRF extension." Cause: gating the get() fallback
   on `prf.enabled === true` from create() - Chrome Android
   doesn't populate that flag even when PRF is available.
2. Reworked to always do a get() fallback. Failure shifted to
   "this device did not return a PRF result."
3. Detected `Object.keys(getClientExtensionResults()).length === 0`
   on Android Chrome and shipped an error message claiming
   Android Credential Manager strips extension results. **This
   theory was wrong** (see Lessons below).
4. Compared against the `passkey-prf-playground` reference
   implementation (https://github.com/leanthebean/passkey_prf_playground).
   Switched create() extension input from
   `{ eval: { first: salt } }` to `{}`, switched
   `residentKey` from `'discouraged'` to `'required'`, set
   `rp.id` explicitly.
5. The user reported that Bitwarden was saving the form-typed
   master password as a regular password entry instead of a
   passkey. Diff against the playground revealed a deterministic
   `user.id` ("nak-master") - the playground uses 64 random
   bytes per registration. Fixed.
6. Final attempt: passkey was correctly created in Bitwarden,
   but PRF still came back empty. User retested
   `passkey-prf-playground` itself on the same device with a
   clean slate; it also returned `PRF Extension Enabled:
   undefined`. The reference implementation fails identically
   on this device. We're hitting a device-side gap, not a code
   gap.

### Lessons learned

- **Empty `clientExtensionResults` is not a Credential Manager
  fingerprint.** It just means whichever authenticator answered
  did not honor the extension. Multiple platforms, multiple
  providers, can produce the same symptom from different
  causes. Don't theorize about platform internals from
  symptoms - ask for the diagnostic and reproduce.
- **`user.id` MUST be a fresh random buffer per registration.**
  A deterministic / stable `user.id` collides with prior
  entries in the credential provider's account index.
  Bitwarden's Android provider in particular responds to a
  colliding user.id by saving the form-typed password as a
  regular password entry, skipping the actual passkey
  creation, and returning a degenerate response. This was the
  single most valuable lesson; bake it in from day one.
- **`extensions.prf` on `create()` should be `{}`, not
  `{ eval: { first: salt } }`.** Passing eval on create() is
  spec-legal and works on iOS Safari + Chrome desktop, but
  Chrome / Android silently drops the entire `prf` extension
  when it can't perform inline evaluation, returning empty
  `clientExtensionResults` instead of `{ prf: { enabled: true } }`.
  The actual eval always happens on the follow-up `get()`.
- **`residentKey: 'required'` is non-negotiable** for cross-
  platform compatibility. Discoverable credentials (resident
  keys) are what Android Credential Manager and iOS
  consistently honor. `'discouraged'` produces wildly
  inconsistent behavior including the empty-extensions failure
  mode.
- **`rp.id: window.location.hostname` must be set explicitly.**
  Chrome desktop derives it implicitly from the origin if
  omitted, but Chrome / Android via Credential Manager refuses
  to register cleanly without an explicit id.
- **A 500ms delay between `create()` and the follow-up `get()`
  is folklore that helps.** The playground uses it with the
  comment "Give a small delay to ensure the credential is fully
  registered." Plausible that Android Credential Manager races
  the credential write on the provider side; the immediate
  get() then misses or returns a degenerate response. Cheap
  insurance, no harm on platforms that don't need it.
- **`authenticatorAttachment: 'platform'` routes to the OS
  built-in authenticator, NOT to whichever third-party provider
  is set as default.** On Android, "platform" resolves to
  Google Play Services. Bitwarden / 1Password answer through
  Credential Manager but as cross-platform-equivalent
  providers, not platform. So the user's "default passkey
  provider" preference does not necessarily route to that
  provider for `attachment: 'platform'` requests.
- **`navigator.credentials.create()` running successfully and
  the user's passkey list showing a new entry is NOT proof
  that PRF works.** The playground prints "Passkey registered
  successfully!" in green even when PRF failed; PRF status is
  a separate one-line attribute below ("PRF Extension Enabled:
  undefined") plus a yellow warning paragraph. The two outcomes
  the playground actually distinguishes:
  - **"PRF functionality verified!"** - the test get() returned
    actual PRF bytes. PRF works.
  - **"PRF enabled but test inconclusive - trying anyway"** /
    "PRF Extension Enabled: undefined" - PRF either is not
    available or the test get() returned no result. PRF does
    not work; the playground proceeds optimistically anyway.
  Always look for the explicit "verified" message before
  declaring PRF working on a device.
- **AI reviewer / theorizer false positives are a documentation
  signal.** I confidently invented two wrong stories during
  this investigation ("Credential Manager strips extensions",
  "Bitwarden Android doesn't implement PRF"). Each was
  plausible-sounding and fit the symptoms. The real cause was
  more boring (device's PRF stack just wasn't returning bytes
  on this Chrome/Play Services build). Demand a reproducible
  diagnostic from a known-good reference (the playground)
  before shipping a remediation message.

### The "correct way" per the playground

The reference implementation that works on supported devices.
Reproduce these knobs verbatim - all of them, not most of them -
when retrying.

Registration (`navigator.credentials.create`):

```js
const challenge = crypto.getRandomValues(new Uint8Array(32));
const userId = crypto.getRandomValues(new Uint8Array(64)); // RANDOM, per registration
const salt = crypto.getRandomValues(new Uint8Array(32));   // PRF input, store this

const createOptions = {
  publicKey: {
    challenge,
    rp: {
      name: 'Nak',
      id: window.location.hostname,                        // EXPLICIT
    },
    user: {
      id: userId,
      name: 'Nak',                                         // username-ish, not a description
      displayName: 'Nak',
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' },                     // ES256
      { alg: -257, type: 'public-key' },                   // RS256
    ],
    authenticatorSelection: {
      userVerification: 'required',
      residentKey: 'required',                             // MUST be required, not discouraged
      authenticatorAttachment: 'platform',
    },
    timeout: 60_000,
    extensions: {
      prf: {},                                             // EMPTY - just enable, don't eval
    },
  },
};

const cred = await navigator.credentials.create(createOptions);
```

Read PRF support hint after registration (informational only -
do not gate on this; some platforms return `prf: undefined` on
create() but still honor PRF on get()):

```js
const ext = cred.getClientExtensionResults();
const prfMaybeSupported = ext.prf && ext.prf.enabled;
```

Wait briefly, then evaluate PRF on a follow-up `get()`:

```js
await new Promise((r) => setTimeout(r, 500));            // 500ms - playground convention

const getOptions = {
  publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{
      type: 'public-key',
      id: new Uint8Array(cred.rawId),                    // Uint8Array, not raw ArrayBuffer
    }],
    userVerification: 'required',
    timeout: 60_000,
    extensions: {
      prf: { eval: { first: salt } },                    // EVAL goes here, on get()
    },
  },
};

const got = await navigator.credentials.get(getOptions);
const prfBytes = got.getClientExtensionResults().prf?.results?.first;
if (!prfBytes || prfBytes.byteLength === 0) {
  throw new Error('PRF not honored - device or provider does not support PRF');
}

// Use prfBytes as a 256-bit AES-GCM key.
const aesKey = await crypto.subtle.importKey(
  'raw', prfBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
);
```

Storage shape for the wrapped envelope:

```ts
interface StoredEnvelope {
  v: 1;
  credentialId: string;   // base64url of cred.rawId, used in allowCredentials on unlock
  salt: string;           // base64 of the PRF input salt
  iv: string;             // base64 of the AES-GCM IV
  ciphertext: string;     // base64 of the AES-GCM wrap of the master password
}
```

Unlock is the same `get()` shape as the post-registration test
above, with the stored credential id and salt. Single biometric
prompt; subsequent unlocks always single-prompt regardless of
the two-prompt enrollment.

Lifecycle invariants:

- Rotating the master password (`changePassword` in
  `src/lib/config.ts`) invalidates the wrapped envelope. Clear
  it; surface a hint to re-enroll.
- `clearStoredConfig` invalidates the wrapped envelope. Clear
  it from `Unlock.svelte`'s Reset path AND
  `EditConfig.svelte`'s Reset path.
- Re-encrypting the config under the SAME password (Keys pane,
  EditConfig save) leaves biometric valid - the wrapped
  password unwraps the same string that decrypts the new blob.

### Failure modes to recognize

| Symptom | Cause | Remediation |
| --- | --- | --- |
| Throw on `create()` with `DOMException: NotAllowedError` | User cancelled biometric prompt, or timeout | Treat as silent fallback to typed password (do not surface a red error) |
| `prf: undefined` (no `prf` field on results) on both create() and get() | Authenticator/provider does not honor PRF on this device | Update Play Services / Chrome / device passkey provider; if still failing, this device cannot host biometric unlock |
| `prf: { enabled: true }` on create() but `results.first` empty on get() | Provider advertised PRF support but didn't actually compute it | Same as above; provider/device gap |
| Bitwarden saves form-typed master password as a regular password entry; no passkey appears in Bitwarden | Deterministic / colliding `user.id` | Use a fresh random `user.id` per registration |
| `create()` succeeds, passkey appears in user's manager, but `clientExtensionResults` is `{}` on get() | PRF stack on this device's authenticator is not returning bytes (Pixel 9 Pro XL + Chrome 147 + current Play Services hits this) | Out of our hands - wait for Play Services to ship support; document the device as currently unsupported |

### What to revisit before retrying

1. **Re-test the reference playground first.** Visit
   <https://www.passkeyprf.com/> on the target device. Look for
   the explicit green "✓ PRF functionality verified!" message
   from the post-registration test. If you see that, retry the
   Nak implementation. If you see "PRF Extension Enabled:
   undefined" or the yellow "PRF extension not supported"
   warning, the device is not ready and the Nak implementation
   cannot compensate.
2. **Confirm Google Play Services version on Android.** PRF on
   Android leans on the Play Services WebAuthn module, not just
   Chrome. A device with current Chrome but lagging Play
   Services fails the same way as a device with an unsupported
   browser.
3. **Re-read the PRF compatibility matrix.** Corbado maintains
   one at <https://www.corbado.com/blog/passkeys-prf-webauthn>
   that updates roughly quarterly. Cross-reference current
   target browsers / providers before resuming.
4. **Cross-check the playground source.** The reference is
   <https://github.com/leanthebean/passkey_prf_playground>.
   If the playground's create()/get() options have changed
   since this writing (commit `c09a43c`), audit Nak against the
   current playground before assuming the patterns above are
   still right.

### References

- WebAuthn PRF spec section -
  <https://www.w3.org/TR/webauthn-3/#prf-extension>
- Yubico Developer Guide to PRF -
  <https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html>
- Corbado Q1 2026 PRF compatibility matrix -
  <https://www.corbado.com/blog/passkeys-prf-webauthn>
- Chromium PRF feature status -
  <https://chromestatus.com/feature/5138422207348736>
- `passkey-prf-playground` reference implementation -
  <https://github.com/leanthebean/passkey_prf_playground>
- Live demo (the diagnostic for "does this device support
  PRF?") - <https://www.passkeyprf.com/>
- Auth & session feature doc - [`./auth-session.md`](./auth-session.md).
  The biometric envelope, when reintroduced, slots in next to
  the existing `nak:config:v1` blob.
