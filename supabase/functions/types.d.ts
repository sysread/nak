// Type declarations for globals injected by the Supabase edge runtime.
// The edge-runtime Docker image provides Supabase.ai.Session as a
// JavaScript global; this file makes deno check aware of it.

export {};

declare global {
  namespace Supabase {
    namespace ai {
      class Session {
        constructor(model: string);
        run(
          input: string,
          options?: { mean_pool?: boolean; normalize?: boolean },
        ): Promise<number[]>;
      }
    }
  }
}
