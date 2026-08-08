// Argument-validation accumulator shared by the function-side write tools.
//
// Tool input validation throws to reject a malformed call before any DB
// work. Done one field at a time (throw on the first bad arg), a model that
// supplies several malformed arguments only learns about them one tool-call
// round trip at a time: it fixes the named field, resubmits, and hits the
// next throw. The observed failure mode was a single memory_create save
// taking five attempts as the model fixed one field and dropped another each
// turn - roughly half the conversation spent round-tripping the same call.
//
// ArgErrors collects every problem with the arguments and surfaces them in
// one throw, so a single round trip tells the model the full set it has to
// fix. Each problem string is preserved verbatim in the combined message, so
// substring-based test assertions and the model-facing wording are unchanged
// from the standalone throws they replace.
// Flag argument keys the tool does not read. Without this, a hallucinated
// parameter fails on whichever required field it displaced ("message is
// required") - accurate but useless, because the model's actual mistake is
// never named. Observed in prod: memory_update called with an invented
// `activity` param round-tripped the required-message rejection three
// times and the model concluded the tool itself was buggy. Keys with
// tool-specific rejections (memory_update's `confidence`) belong in
// `known` so the specific message fires instead of the generic one.
export function rejectUnknownArgs(
  errs: ArgErrors,
  args: Record<string, unknown>,
  known: readonly string[],
): void {
  for (const key of Object.keys(args)) {
    if (!known.includes(key)) {
      errs.add(
        `unrecognized parameter: ${key} - check the tool spec for the valid parameters`,
      );
    }
  }
}

// Name a value's JSON type for a type-error message. Models routinely
// quote numeric arguments ({"confidence": "5.0"}); a bare "must be a
// finite number" reads as a range complaint when the value looks right,
// so the rejection has to say what type actually arrived.
export function describeJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const t = typeof value;
  if (t === 'object') return 'an object';
  if (t === 'string') return 'a string';
  if (t === 'boolean') return 'a boolean';
  if (t === 'number') return 'a number';
  return t;
}

// Validate a required-to-be-numeric argument. Returns the number when
// valid; records a type error naming what arrived otherwise.
export function requireFiniteNumber(
  errs: ArgErrors,
  name: string,
  value: unknown,
): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  errs.add(
    `type error: ${name} expects a finite number, but ${describeJsonType(value)} was found`,
  );
  return null;
}

export class ArgErrors {
  private readonly problems: string[] = [];

  // Record a problem. The message should name the offending field and what
  // is wrong, phrased exactly as a standalone `throw new Error(...)` would
  // have been - the combined throw is the only behavior change.
  add(message: string): void {
    this.problems.push(message);
  }

  get any(): boolean {
    return this.problems.length > 0;
  }

  // Throw once if anything was recorded. A lone problem reads identically to
  // the old single throw; multiple are joined with "; " so the model sees
  // the whole set in one error.
  throwIfAny(): void {
    if (this.problems.length === 1) {
      throw new Error(this.problems[0]);
    }
    if (this.problems.length > 1) {
      throw new Error(this.problems.join('; '));
    }
  }
}
