import { describe, it, expect } from 'vitest';
import { coerceSettings } from '../src/lib/supabase';

describe('coerceSettings', () => {
  it('returns an empty object for non-object input', () => {
    expect(coerceSettings(null)).toEqual({});
    expect(coerceSettings(undefined)).toEqual({});
    expect(coerceSettings('smart')).toEqual({});
    expect(coerceSettings(42)).toEqual({});
  });

  it('coerces a well-formed modelProfiles list and drops bad entries', () => {
    const good = {
      id: 'p1',
      name: 'Everyday',
      modelId: 'glm-5-1',
      thinking: 'high',
      verbosity: 'low',
      isDefault: true,
      contextWindow: 200_000,
      supportsReasoning: true,
      supportsVision: true,
      supportsResponseFormat: true,
      modelLabel: 'GLM 5.1',
    };
    expect(
      coerceSettings({
        modelProfiles: [good, { ...good, id: 'p2', thinking: 'bogus' }],
      })
    ).toEqual({ modelProfiles: [good] });
  });

  it('normalizes modelProfiles to exactly one default on read', () => {
    const base = {
      id: 'p1',
      name: 'A',
      modelId: 'glm-5-1',
      thinking: 'low',
      verbosity: 'medium',
      isDefault: false,
      contextWindow: 200_000,
      supportsReasoning: true,
      supportsVision: true,
      supportsResponseFormat: true,
      modelLabel: 'GLM 5.1',
    };
    const result = coerceSettings({
      modelProfiles: [base, { ...base, id: 'p2', name: 'B' }],
    });
    expect(result.modelProfiles?.map((p) => p.isDefault)).toEqual([true, false]);
  });

  it('omits modelProfiles entirely when no entry survives - the app seeds the starter profile', () => {
    expect(coerceSettings({ modelProfiles: [] })).toEqual({});
    expect(coerceSettings({ modelProfiles: [{ id: '' }] })).toEqual({});
    expect(coerceSettings({ modelProfiles: 'nope' })).toEqual({});
  });

  it('drops the legacy pre-profile keys like any unknown key', () => {
    // Blobs written before the profile system may still carry these;
    // they are ignored on read and cleared on the next profiles write.
    expect(
      coerceSettings({
        defaultModel: 'smart',
        tierModels: { smart: { modelId: 'x' } },
        defaultReasoningEffort: 'low',
        defaultVerbosity: 'medium',
      })
    ).toEqual({});
  });

  it('drops unknown keys silently', () => {
    expect(coerceSettings({ rando: 'value', imageModel: 'flux-dev' })).toEqual({
      imageModel: 'flux-dev',
    });
    expect(coerceSettings({ rando: 'value' })).toEqual({});
  });

  it('passes through a non-empty imageModel string and drops bad values', () => {
    expect(coerceSettings({ imageModel: 'flux-dev' })).toEqual({ imageModel: 'flux-dev' });
    // Empty / non-string is "not set" - the server falls back to the default.
    expect(coerceSettings({ imageModel: '' })).toEqual({});
    expect(coerceSettings({ imageModel: 123 })).toEqual({});
  });

  it('tolerates an empty object', () => {
    expect(coerceSettings({})).toEqual({});
  });

  it('passes through valid theme fields', () => {
    expect(coerceSettings({ colorMode: 'light', accent: 'red' })).toEqual({
      colorMode: 'light',
      accent: 'red',
    });
    expect(coerceSettings({ colorMode: 'system' })).toEqual({ colorMode: 'system' });
  });

  it('drops bad theme values', () => {
    expect(coerceSettings({ colorMode: 'neon', accent: 'chartreuse' })).toEqual({});
    expect(coerceSettings({ colorMode: null, accent: 123 })).toEqual({});
  });

  it('mixes image-model + theme fields correctly', () => {
    expect(
      coerceSettings({ imageModel: 'flux-dev', colorMode: 'dark', accent: 'red' })
    ).toEqual({ imageModel: 'flux-dev', colorMode: 'dark', accent: 'red' });
  });

  it('passes through well-formed systemPrompts', () => {
    const prompts = [
      { id: 'a', name: 'Rude reviewer', body: 'Be curt.', enabledByDefault: true },
      { id: 'b', name: 'Haiku', body: 'Reply in haiku.', enabledByDefault: false },
    ];
    expect(coerceSettings({ systemPrompts: prompts })).toEqual({ systemPrompts: prompts });
  });

  it('drops malformed systemPrompts entries without dropping the valid ones', () => {
    const result = coerceSettings({
      systemPrompts: [
        { id: 'good', name: 'Ok', body: 'ok', enabledByDefault: true },
        { id: '', name: 'missing id', body: 'x', enabledByDefault: false },
        { name: 'no id', body: 'x', enabledByDefault: false },
        { id: 'bad', name: null, body: 'x', enabledByDefault: false },
        'not an object',
        42,
      ],
    });
    expect(result.systemPrompts).toEqual([
      { id: 'good', name: 'Ok', body: 'ok', enabledByDefault: true },
    ]);
  });

  it('coerces enabledByDefault to strict true (truthy strings stay false)', () => {
    const result = coerceSettings({
      systemPrompts: [
        { id: 'a', name: 'a', body: '', enabledByDefault: 'yes' },
        { id: 'b', name: 'b', body: '', enabledByDefault: true },
      ],
    });
    expect(result.systemPrompts).toEqual([
      { id: 'a', name: 'a', body: '', enabledByDefault: false },
      { id: 'b', name: 'b', body: '', enabledByDefault: true },
    ]);
  });

  it('omits systemPrompts when the input array is empty or all-invalid', () => {
    expect(coerceSettings({ systemPrompts: [] }).systemPrompts).toBeUndefined();
    expect(
      coerceSettings({ systemPrompts: ['nope', 123, null] }).systemPrompts
    ).toBeUndefined();
  });

  it('passes through a valid defaultLogLevel', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error']) {
      expect(coerceSettings({ defaultLogLevel: level })).toEqual({
        defaultLogLevel: level,
      });
    }
  });

  it('drops an unknown defaultLogLevel value', () => {
    expect(coerceSettings({ defaultLogLevel: 'verbose' })).toEqual({});
    expect(coerceSettings({ defaultLogLevel: '' })).toEqual({});
    expect(coerceSettings({ defaultLogLevel: null })).toEqual({});
    expect(coerceSettings({ defaultLogLevel: 0 })).toEqual({});
  });

  it('passes through a boolean emphasisMarkdown', () => {
    expect(coerceSettings({ emphasisMarkdown: true })).toEqual({
      emphasisMarkdown: true,
    });
    expect(coerceSettings({ emphasisMarkdown: false })).toEqual({
      emphasisMarkdown: false,
    });
  });

  it('drops a non-boolean emphasisMarkdown value', () => {
    // Truthy strings must not coerce to true - the setting is a
    // hard boolean, and the coercer's job is to reject anything else
    // so a corrupt blob from an older build can't accidentally enable
    // the prompt nudge.
    expect(coerceSettings({ emphasisMarkdown: 'yes' })).toEqual({});
    expect(coerceSettings({ emphasisMarkdown: 1 })).toEqual({});
    expect(coerceSettings({ emphasisMarkdown: 0 })).toEqual({});
    expect(coerceSettings({ emphasisMarkdown: null })).toEqual({});
  });

  it('passes through non-empty userName and userLocation strings', () => {
    expect(coerceSettings({ userName: 'Ada' })).toEqual({ userName: 'Ada' });
    expect(coerceSettings({ userLocation: 'Lisbon' })).toEqual({
      userLocation: 'Lisbon',
    });
    expect(
      coerceSettings({ userName: 'Ada Lovelace', userLocation: 'London' })
    ).toEqual({ userName: 'Ada Lovelace', userLocation: 'London' });
  });

  it('drops empty / non-string profile fields so absent === blank', () => {
    // Empty string is the "not set" sentinel. The coercer drops it
    // so the appendix builder in chat/loop.ts never has to
    // distinguish "user typed nothing" from "field never set."
    expect(coerceSettings({ userName: '' })).toEqual({});
    expect(coerceSettings({ userLocation: '' })).toEqual({});
    expect(coerceSettings({ userName: null })).toEqual({});
    expect(coerceSettings({ userName: 42 })).toEqual({});
    expect(coerceSettings({ userLocation: { city: 'Lisbon' } })).toEqual({});
  });

  it('drops profile fields above the 200-char ceiling', () => {
    // Defensive cap so a corrupt blob can't balloon the per-turn
    // system prompt. 201 chars rejects, 200 accepts.
    const ok = 'a'.repeat(200);
    const tooLong = 'a'.repeat(201);
    expect(coerceSettings({ userName: ok })).toEqual({ userName: ok });
    expect(coerceSettings({ userName: tooLong })).toEqual({});
    expect(coerceSettings({ userLocation: tooLong })).toEqual({});
  });
});
