/**
 * Barrel for the Supabase data-layer types, sliced by domain. The
 * SupabaseService class (../../supabase.ts) re-exports this whole barrel
 * so `$lib/supabase` stays the single import surface for every consumer;
 * importing a specific domain module directly
 * (`$lib/supabase/types/cookbook`) is also fine when only one domain's
 * shapes are needed.
 */
export * from './core';
export * from './chat';
export * from './memories';
export * from './wiki';
export * from './cookbook';
export * from './documents';
export * from './settings';
