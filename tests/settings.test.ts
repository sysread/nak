/**
 * Unit coverage for the Settings modal's screen-scoped UI primitives.
 * Pure functions - no runes, no DOM, no reactive state - tested via
 * plain vitest.
 *
 * The companion `src/screens/Settings.svelte` is the only caller that
 * wires these into Svelte reactivity; a port to another framework
 * would re-use this module untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  aboutActionLabel,
  authPasswordError,
  exportConfigFilename,
  formatBuildTime,
  notifyOnCompleteNotice,
  notifyPermissionNudgeVisible,
  notifyPermissionRequestNotice,
  toggleNotice,
  userFieldNotice,
} from '../src/lib/ui/settings';

describe('authPasswordError', () => {
  it('requires the current password first', () => {
    expect(authPasswordError('', 'longenough', 'longenough')).toBe(
      'Enter your current account password.'
    );
  });

  it('holds the new-password floor at 8 characters (above Supabase\'s 6)', () => {
    expect(authPasswordError('current', 'short7c', 'short7c')).toBe(
      'New password must be at least 8 characters.'
    );
    expect(authPasswordError('current', 'exactly8', 'exactly8')).toBeNull();
  });

  it('rejects a mismatched confirmation', () => {
    expect(authPasswordError('current', 'longenough', 'different1')).toBe(
      'New password and confirmation do not match.'
    );
  });

  it('reports the topmost offending field when several are wrong', () => {
    // Empty current + short new: the current-password error wins because
    // the check order mirrors the form's visual order.
    expect(authPasswordError('', 'short', 'other')).toBe(
      'Enter your current account password.'
    );
  });

  it('returns null for a submittable form', () => {
    expect(authPasswordError('current', 'longenough', 'longenough')).toBeNull();
  });
});

describe('toggleNotice', () => {
  it('answers the intents flip with the daily-pass framing', () => {
    expect(toggleNotice('intents', true)).toBe(
      'Intents enabled. Nak will begin forming growth intentions from the next daily pass; nothing changes mid-conversation.'
    );
    expect(toggleNotice('intents', false)).toBe(
      'Intents disabled. Existing intentions stop influencing replies and the pipeline goes idle; they are kept, not deleted.'
    );
  });

  it('keeps the emphasis-markdown copy terse', () => {
    expect(toggleNotice('emphasisMarkdown', true)).toBe('Emphasis markdown enabled.');
    expect(toggleNotice('emphasisMarkdown', false)).toBe('Emphasis markdown disabled.');
  });

  it('spells out what keeps working when a wiki agent is disabled', () => {
    expect(toggleNotice('wikiAutomatic', true)).toBe('Automatic wiki enabled.');
    expect(toggleNotice('wikiAutomatic', false)).toBe(
      'Automatic wiki disabled. Manual edits and the per-article "ask agent to update" button still work.'
    );
    expect(toggleNotice('wikiRecordExtraction', true)).toBe(
      'Automatic record extraction enabled.'
    );
    expect(toggleNotice('wikiRecordExtraction', false)).toBe(
      'Automatic record extraction disabled. Manually-added records still work; the background agent will stop creating new ones.'
    );
    expect(toggleNotice('wikiLibrarian', true)).toBe('Wiki librarian enabled.');
    expect(toggleNotice('wikiLibrarian', false)).toBe(
      'Wiki librarian disabled. Existing articles are unaffected.'
    );
  });

  it('reassures that existing memories survive a librarian disable', () => {
    expect(toggleNotice('memoryLibrarian', true)).toBe('Memory librarian enabled.');
    expect(toggleNotice('memoryLibrarian', false)).toBe(
      'Memory librarian disabled. Existing memories are unaffected.'
    );
  });
});

describe('notifyOnCompleteNotice', () => {
  it('confirms plainly when the browser can fire OS notifications', () => {
    expect(notifyOnCompleteNotice(true, true)).toBe('Reply notifications enabled.');
  });

  it('names the sidebar fallback on unsupported browsers', () => {
    expect(notifyOnCompleteNotice(true, false)).toBe(
      'Reply notifications enabled. This browser does not support OS notifications, so Nak will flag unread threads in the sidebar instead.'
    );
  });

  it('ignores browser support when disabling', () => {
    expect(notifyOnCompleteNotice(false, true)).toBe('Reply notifications disabled.');
    expect(notifyOnCompleteNotice(false, false)).toBe('Reply notifications disabled.');
  });
});

describe('notifyPermissionNudgeVisible', () => {
  it('shows exactly when the synced preference is on but this browser lacks the grant', () => {
    expect(notifyPermissionNudgeVisible(true, true, 'default')).toBe(true);
    expect(notifyPermissionNudgeVisible(true, true, 'denied')).toBe(true);
  });

  it('hides once the grant lands', () => {
    expect(notifyPermissionNudgeVisible(true, true, 'granted')).toBe(false);
  });

  it('hides when the preference is off or the API is missing', () => {
    expect(notifyPermissionNudgeVisible(false, true, 'default')).toBe(false);
    expect(notifyPermissionNudgeVisible(true, false, 'unsupported')).toBe(false);
  });
});

describe('notifyPermissionRequestNotice', () => {
  it('routes a grant to the info slot', () => {
    expect(notifyPermissionRequestNotice('granted')).toEqual({
      kind: 'info',
      text: 'Reply notifications enabled for this browser.',
    });
  });

  it('points a deny at the browser-settings unblock path', () => {
    expect(notifyPermissionRequestNotice('denied')).toEqual({
      kind: 'error',
      text: 'Browser notifications are blocked for this site. Allow them in your browser settings, then reload.',
    });
  });

  it('invites a retry when the prompt was dismissed without picking', () => {
    const stillOff = {
      kind: 'error',
      text: 'Notifications still off. Click the button again to retry, or allow them in your browser settings.',
    };
    expect(notifyPermissionRequestNotice('default')).toEqual(stillOff);
    expect(notifyPermissionRequestNotice('unsupported')).toEqual(stillOff);
  });
});

describe('userFieldNotice', () => {
  it('confirms a save with the field name', () => {
    expect(userFieldNotice('Name', 'Ada')).toBe('Name saved.');
    expect(userFieldNotice('Location', 'Lisbon')).toBe('Location saved.');
  });

  it('acknowledges an empty commit as a deliberate clear', () => {
    expect(userFieldNotice('Name', '')).toBe('Name cleared.');
    expect(userFieldNotice('Location', '')).toBe('Location cleared.');
  });
});

describe('exportConfigFilename', () => {
  it('stamps the download name with a filesystem-safe ISO timestamp', () => {
    const now = new Date('2026-07-03T12:34:56.789Z');
    expect(exportConfigFilename(now)).toBe('nak-config-2026-07-03T12-34-56-789Z.json');
  });

  it('leaves no colon or extra dot for a path-hostile filesystem to choke on', () => {
    const name = exportConfigFilename(new Date());
    expect(name).not.toContain(':');
    // The only dot left is the .json extension's.
    expect(name.match(/\./g)).toEqual(['.']);
  });
});

describe('formatBuildTime', () => {
  it('returns the raw value when the stamp does not parse (the dev placeholder)', () => {
    expect(formatBuildTime('dev')).toBe('dev');
    expect(formatBuildTime('not a date')).toBe('not a date');
  });

  it('humanizes a valid build stamp via the locale formatter', () => {
    const iso = '2026-03-04T05:06:00.000Z';
    const expected = new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(formatBuildTime(iso)).toBe(expected);
    expect(formatBuildTime(iso)).not.toBe(iso);
  });
});

describe('aboutActionLabel', () => {
  it('narrates in-flight work over everything else', () => {
    expect(aboutActionLabel('reloading', true)).toBe('Reloading…');
    expect(aboutActionLabel('reloading', false)).toBe('Reloading…');
    expect(aboutActionLabel('checking', true)).toBe('Checking…');
    expect(aboutActionLabel('checking', false)).toBe('Checking…');
  });

  it('advertises the next action when idle', () => {
    expect(aboutActionLabel('idle', true)).toBe('Reload to update');
    expect(aboutActionLabel('idle', false)).toBe('Check for updates');
  });
});
