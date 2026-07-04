/**
 * Coverage for the Chat screen's small scoped primitives
 * (src/lib/ui/chat-screen.ts). Pure functions - plain vitest, no
 * mount; the navigator read and the 1Hz tick stay in the screen.
 */
import { describe, it, expect } from 'vitest';
import {
  isMacPlatform,
  rateLimitRemainingSeconds,
  sendHintLabel,
} from '../src/lib/ui/chat-screen';

describe('rateLimitRemainingSeconds', () => {
  const NOW = 1_700_000_000_000;

  it('is 0 when no wait is active', () => {
    expect(rateLimitRemainingSeconds(null, NOW)).toBe(0);
  });

  it('rounds a fractional remainder up so the countdown never shows a premature 0', () => {
    expect(rateLimitRemainingSeconds(NOW + 1, NOW)).toBe(1);
    expect(rateLimitRemainingSeconds(NOW + 4200, NOW)).toBe(5);
  });

  it('floors at 0 once the wake time has passed', () => {
    expect(rateLimitRemainingSeconds(NOW - 5000, NOW)).toBe(0);
    expect(rateLimitRemainingSeconds(NOW, NOW)).toBe(0);
  });
});

describe('isMacPlatform', () => {
  it('matches the modern and legacy platform strings, case-insensitively', () => {
    expect(isMacPlatform('macOS')).toBe(true);
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('Windows')).toBe(false);
    expect(isMacPlatform('Linux x86_64')).toBe(false);
    expect(isMacPlatform('')).toBe(false);
  });
});

describe('sendHintLabel', () => {
  it('names the platform submit shortcut', () => {
    expect(sendHintLabel(true)).toBe('\u2318-enter sends');
    expect(sendHintLabel(false)).toBe('ctrl-enter sends');
  });
});
