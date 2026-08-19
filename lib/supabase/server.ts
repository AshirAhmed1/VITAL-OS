import { cookies } from "next/headers";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in environment.`);
  }
  return value;
}

/**
 * Per-request Supabase client, bound to the caller's auth cookies.
 *
 * Must be created inside a request scope (Route Handler / Server Component) —
 * `cookies()` throws otherwise. Never hoist this to a module-level singleton:
 * a shared client would leak one clinician's session into another clinician's
 * request, and would evaluate every RLS policy as `anon`.
 */
export function createServerSupabase(): SupabaseClient {
  const cookieStore = cookies();

  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot write cookies. Token refresh is handled
            // by middleware.ts, so a failure here is expected and harmless.
          }
        },
      },
    }
  );
}
