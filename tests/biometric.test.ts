import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isBiometricSupported,
  isBiometricEnrolled,
  clearBiometric,
  __test,
} from '../src/lib/biometric';

describe('biometric', () => {
  beforeEach(() => {
    localStorage.clear();
    // The module reads PublicKeyCredential off the global at call
    // time. Each test sets up exactly the shape it needs.
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  });

  afterEach(() => {
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  });

  it('reports unsupported when WebAuthn is missing', async () => {
    expect(await isBiometricSupported()).toBe(false);
  });

  it('reports unsupported when the platform authenticator probe is false', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(false),
    };
    expect(await isBiometricSupported()).toBe(false);
  });

  it('reports supported when the platform authenticator probe is true', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(true),
    };
    expect(await isBiometricSupported()).toBe(true);
  });

  it('handles the probe throwing as unsupported', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: vi
        .fn()
        .mockRejectedValue(new Error('blocked')),
    };
    expect(await isBiometricSupported()).toBe(false);
  });

  it('isBiometricEnrolled reflects localStorage presence', () => {
    expect(isBiometricEnrolled()).toBe(false);
    localStorage.setItem(
      __test.STORAGE_KEY,
      JSON.stringify({
        v: 1,
        credentialId: 'aGVsbG8',
        salt: 'AAAA',
        iv: 'AAAA',
        ciphertext: 'AAAA',
      }),
    );
    expect(isBiometricEnrolled()).toBe(true);
  });

  it('clearBiometric wipes the envelope', () => {
    localStorage.setItem(
      __test.STORAGE_KEY,
      JSON.stringify({
        v: 1,
        credentialId: 'aGVsbG8',
        salt: 'AAAA',
        iv: 'AAAA',
        ciphertext: 'AAAA',
      }),
    );
    expect(isBiometricEnrolled()).toBe(true);
    clearBiometric();
    expect(isBiometricEnrolled()).toBe(false);
  });

  it('uses the documented constants', () => {
    expect(__test.STORAGE_KEY).toBe('nak:biometric:v1');
    expect(__test.SALT_BYTES).toBe(32);
    expect(__test.IV_BYTES).toBe(12);
  });
});
