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
