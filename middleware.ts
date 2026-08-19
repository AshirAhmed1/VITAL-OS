import { NextResponse, type NextRequest } from "next/server";

import { createServerClient } from "@supabase/ssr";

/**
 * Refreshes the Supabase auth token on every matched request.
 *
 * Next 14 uses `middleware.ts`. The current Supabase docs show `proxy.ts` with
 * an exported `proxy` function — that is the Next 16 convention and is silently
 * ignored here.
 *
 * This middleware deliberately performs no redirects: `AppGate` gates the UI
 * client-side, and a server-side redirect would race it. Its only job is to
 * keep the access token fresh and hand the refreshed cookies to both the
 * server (via `request.cookies`) and the browser (via `response.cookies`).
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without Supabase configured there is no session to refresh. Fall through
  // rather than throwing — a misconfigured env should not 500 every route.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        response = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }

        // Cache-Control: private, no-store and friends. A cached Set-Cookie
        // response would serve one clinician's session to the next visitor.
        for (const [header, headerValue] of Object.entries(headers)) {
          response.headers.set(header, headerValue);
        }
      },
    },
  });

  // Verifies the JWT signature against the project's published keys, unlike
  // getSession(), whose user object must not be trusted in server code.
  await supabase.auth.getClaims();

  return response;
}

export const config = {
  matcher: [
    /*
     * Every path except static assets and image files. Auth cookies are needed
     * on page routes and API routes alike.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
