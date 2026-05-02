# Security model

Nak is bring-your-own-infrastructure: your Supabase project holds your
data, your Venice key pays for your own usage. This page covers how
Nak protects the keys you give it.

## What the master password protects

## How keys are encrypted

## What Supabase stores

## Locking the session

## Biometric unlock

On devices with built-in biometrics — TouchID, FaceID, Windows
Hello, Android fingerprint — you can opt in to unlock Nak with a
biometric gesture instead of typing the master password every
time. This is per-device: enabling it on your phone has no effect
on your laptop, and signing in from a fresh browser starts you
back at the typed-password path.

**Turn it on** under Settings -> Security -> Biometric unlock.
You'll be asked for your master password once to confirm, then
your device prompts you for a biometric / PIN check to seal the
enrollment. After that, every time the Unlock screen appears it
will pop the system biometric prompt automatically - tap to
authenticate and you're in. If you dismiss the prompt or it
times out, the screen falls back to the typed-password field
with the master password input focused, and the "Unlock with
biometric" button stays visible so you can retry without
refreshing.

**Turn it off** in the same place. Disabling clears the
device-local enrollment immediately; the encrypted config blob
itself is untouched, so you can keep using the typed password.

**What's actually stored.** Your master password is wrapped under
a key that lives in your device's secure hardware (Apple Secure
Enclave, Android StrongBox, Windows TPM). The wrapped blob sits
in browser localStorage alongside the encrypted config; on its
own it's useless. The wrap can only be opened after a successful
biometric or device-PIN gesture, and the unwrapping happens
inside the secure element — your raw fingerprint or face data
never reaches the browser, and neither does the unwrap key.

**When biometric unlock is unavailable.**

- Your browser doesn't expose a built-in user-verifying
  authenticator (older mobile Safari, Firefox without WebAuthn
  enabled, etc.). The Settings toggle is hidden.
- Your credential provider or device authenticator doesn't
  implement the WebAuthn PRF extension that this feature relies
  on (some older Android Play Services builds, some older
  third-party passkey providers). Enrollment will fail with a
  diagnostic message; nothing is stored, and the typed-password
  path keeps working. If you hit this, make sure your device
  passkey provider (Google Password Manager, Bitwarden, etc.) is
  up to date.
- You changed your master password — the existing biometric
  enrollment wraps the old password and can't decrypt the new
  blob. Settings clears the old enrollment and prompts you to
  re-enable under the new password.

The typed-password path is always available. Biometric unlock is
opt-in convenience, never the only way in.

## Rotating the master password

## When to sign out vs. lock

## Where to go next

- [Export & import](./export-import.md) — moving keys to another
  browser.
- [Settings overview](./settings.md).

---
Back to the [index](./README.md).
