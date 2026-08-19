import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

/**
 * Browser Supabase client, for Client Components only.
 *
 * A module-level singleton is correct here — unlike the server, a browser
 * module instance serves exactly one user, and `@supabase/ssr` writes the
 * session to cookies so the server can read it on the next request.
 */
export function createBrowserSupabase(): SupabaseClient {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in environment."
    );
  }

  browserClient = createBrowserClient(url, key);
  return browserClient;
}
