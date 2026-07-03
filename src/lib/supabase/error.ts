/**
 * The data layer's error wrapper. Every query/RPC wrapper in the
 * SupabaseService facade (../supabase.ts) and the domain slice modules
 * (./samskara.ts, ...) rethrows supabase-js errors as SupabaseError so
 * callers can distinguish data-layer failures from programming errors
 * by name. Internal to the data layer - UI code catches plain Error.
 */
export class SupabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseError';
  }
}
