// Venice wire-shape for the edge function (Deno side). This is a deliberate
// duplicate of the embed half of src/lib/venice.ts: the app is Node/Vite and
// this is a Deno island, and coupling the two toolchains before the function
// surface settles is premature (see supabase/functions/README.md, "Deno
// island, intentionally"). Sharing the browser client
// is a consolidation-phase decision, not a step-5 one.
//
// Kept pure and fetch-injectable on purpose: the handler in venice/index.ts is
// a thin shell around these, so the request-shaping and response-parsing logic
// is unit-testable with a fake fetch and no network (see tests/).
//
// Split by concern into _shared/venice/<concern>.ts; this barrel re-exports
// every symbol so all import sites keep their _shared/venice.ts specifier.
export * from './venice/shared.ts';
export * from './venice/complete.ts';
export * from './venice/image.ts';
export * from './venice/text-parser.ts';
export * from './venice/scrape.ts';
export * from './venice/billing.ts';
export * from './venice/models.ts';
export * from './venice/decisions.ts';
