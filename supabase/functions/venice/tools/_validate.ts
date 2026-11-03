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

// Validate a required-to-be-numeric argument. Accepts a finite number,
// or a string that parses to one - models routinely quote numeric
// arguments ({"confidence": "5.0"}) and rejecting those only buys a
// retry round trip. Anything else records a type error naming what
// actually arrived, so the model's fix is obvious.
export function requireFiniteNumber(
  errs: ArgErrors,
  name: string,
  value: unknown,
): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
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

// Check whether a value matches a JSON Schema type string. Only the five
// types the validator supports are checked; an unrecognised type string
// (or a non-string type field) passes through as a match so the validator
// does not reject on a schema it doesn't fully understand.
function matchesJsonType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      // JSON null is its own type, not an object.
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

// Central schema-based argument validator. Runs the JSON Schema checks that
// are mechanical enough to generalise - unknown keys (additionalProperties),
// missing required fields, type mismatches, string length bounds, numeric
// range bounds, and enum membership - and throws an ArgErrors combined error
// listing every problem in one pass.
//
// This does NOT replace per-tool validation: cross-field rules, semantic
// constraints, and type coercion (like requireFiniteNumber accepting quoted
// numerics) stay in the tool. The validator rejects type mismatches rather
// than coercing, so tools that rely on coercion keep their own logic and
// call validateToolArgs first for the mechanical checks.
//
// Only top-level properties are checked. Nested objects and array items are
// left to the tool, which has the domain knowledge to validate them.
export function validateToolArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): void {
  if (!schema) return;
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return;

  const errs = new ArgErrors();
  const knownKeys = Object.keys(properties);

  // Per-op required-field rules (x-per-op-required, a JSON Schema x-
  // extension key). A combination tool's flat schema can only mark the
  // discriminator required - the per-op requireds are op-conditional -
  // so without this the validator and the handler each refuse a
  // malformed call but never combine: a compound fumble (invalid op +
  // missing fields) reported only the enum problem and cost the model
  // an extra round trip, the exact one-problem-per-round-trip failure
  // ArgErrors exists to prevent. The map may be PARTIAL: ops absent
  // from it (conditional create-or-update requireds, or nothing
  // required) keep handler-only validation. Schemas without the key
  // behave exactly as before.
  const perOp = schema['x-per-op-required'] as
    | Record<string, readonly string[]>
    | undefined;
  const opEnum = Array.isArray(properties.op?.enum)
    ? (properties.op.enum as unknown[])
    : [];

  // Unknown-key rejection. Only fires when the schema explicitly closes the
  // object with additionalProperties: false - schemas that allow extra keys
  // pass them through. This replaces the per-tool rejectUnknownArgs calls,
  // which hardcoded the known-key list; the schema already has it.
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!knownKeys.includes(key)) {
        errs.add(
          `unrecognized parameter: ${key} - check the tool spec for the valid parameters`,
        );
      }
    }
  }

  // Required-field check. The `activity` param is injected into the schema's
  // properties and required array at wire-projection time (injectActivityParam
  // in src/lib/tools/wire.ts) so the model narrates each call. The dispatcher
  // strips `activity` from args before calling the validator, so it is always
  // absent from args. Skipping it here prevents a false "missing required
  // parameter: activity" rejection on every single tool call. This is the
  // one hard-coded exemption in the validator.
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  for (const field of required) {
    if (field === 'activity') continue;
    if (args[field] === undefined) {
      errs.add(`missing required parameter: ${field}`);
    }
  }

  // Op error first: when per-op rules are in play and the op value is
  // present but illegal, its enum rejection leads the combined message
  // (the coordinator's precedence story - the op error, then arg
  // errors). Collected here rather than in the per-property loop below,
  // which SKIPS op when per-op rules are active so the enum problem is
  // never reported twice.
  if (perOp && args.op !== undefined && !opEnum.includes(args.op)) {
    errs.add(
      `op must be one of: ${opEnum.map((v) => (v === null ? 'null' : String(v))).join(', ')}`,
    );
  }

  // Per-property checks: type, length bounds, range bounds, enum. Only keys
  // the schema declares are checked here; unknown keys were handled above.
  for (const [name, value] of Object.entries(args)) {
    // op is owned by the per-op block (above + below) when the rules
    // key is present - the loop's enum check would duplicate it.
    if (perOp && name === 'op') continue;
    const propSchema = properties[name];
    if (!propSchema) continue;

    const expectedType = propSchema.type;
    if (
      typeof expectedType === 'string' &&
      !matchesJsonType(value, expectedType)
    ) {
      errs.add(
        `type error: ${name} expects a ${expectedType}, but ${describeJsonType(value)} was found`,
      );
      // A type mismatch makes the length/range/enum checks meaningless -
      // you can't check maxLength on a number. Skip to the next property
      // so the model gets the one fix that matters: correct the type.
      continue;
    }

    if (
      typeof value === 'string' &&
      typeof propSchema.maxLength === 'number' &&
      value.length > propSchema.maxLength
    ) {
      errs.add(
        `${name} exceeds maximum length of ${propSchema.maxLength} characters (got ${value.length})`,
      );
    }

    if (
      typeof value === 'string' &&
      typeof propSchema.minLength === 'number' &&
      value.length < propSchema.minLength
    ) {
      errs.add(
        `${name} is shorter than minimum length of ${propSchema.minLength} characters`,
      );
    }

    if (
      typeof value === 'number' &&
      typeof propSchema.minimum === 'number' &&
      value < propSchema.minimum
    ) {
      errs.add(`${name} is below the minimum of ${propSchema.minimum}`);
    }

    if (
      typeof value === 'number' &&
      typeof propSchema.maximum === 'number' &&
      value > propSchema.maximum
    ) {
      errs.add(`${name} exceeds the maximum of ${propSchema.maximum}`);
    }

    if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(value)) {
      // Render null as the literal word - String(null) is '' and a
      // dangling ', ' hides that null is a legal value (the nullable
      // outcome params' clear-state rides the enum).
      const legal = (propSchema.enum as unknown[])
        .map((v) => (v === null ? 'null' : String(v)))
        .join(', ');
      errs.add(`${name} must be one of: ${legal}`);
    }
  }

  // Per-op accumulation. A legal op gets its mapped fields' presence
  // checked (the handler keeps its own stricter falsy/trim checks -
  // this is the additive backstop that makes the whole set visible in
  // one throw). An illegal or missing op cannot attribute fields, so
  // the message carries one clause per mapped op - the full argument
  // map in the same round trip. Only mapped ops appear; a legal op
  // absent from a partial map keeps handler-only validation.
  if (perOp) {
    const opValue = args.op;
    if (opValue !== undefined && opEnum.includes(opValue)) {
      const rule = perOp[opValue as string];
      if (rule) {
        for (const field of rule) {
          if (args[field] === undefined) {
            errs.add(`missing required parameter: ${field} (required by op=${String(opValue)})`);
          }
        }
      }
    } else {
      for (const [opName, fields] of Object.entries(perOp)) {
        errs.add(`op=${opName} requires: ${fields.join(', ')}`);
      }
    }
  }

  errs.throwIfAny();
}
