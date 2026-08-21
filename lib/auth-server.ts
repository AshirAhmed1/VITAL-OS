/**
 * Server-side caller identity, sourced from the database.
 *
 * Replaces parseRoleFromRequest() (lib/auth.ts) as the authorization source.
 * That function read the x-vital-role header, which any client can set --
 * `Invoke-RestMethod -Headers @{"x-vital-role"="doctor"}` was enough to reach
 * every doctor-only route. This reads the clinicians row belonging to the
 * authenticated session instead, so the caller cannot assert their own role.
 *
 * Server-only. Importing this from a client component will fail to build:
 * createServerSupabase() calls next/headers cookies().
 */

import { parseRole, type VitalRole } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase/server";

export type CallerClinician = {
  /** auth.users.id, which is also clinicians.id. */
  userId: string;
  role: VitalRole;
  /** Tenancy scope. M3 RLS policies filter on this. */
  hospitalId: string;
};

/**
 * Resolves the authenticated caller's clinician row.
 *
 * Returns null for every failure -- no session, invalid token, no clinicians
 * row, or a role outside VitalRole. Callers treat null as "deny", so this
 * fails closed by construction; there is no error branch to forget.
 *
 * Must be called inside a request scope (Route Handler), because
 * createServerSupabase() reads request cookies.
 */
export async function getCallerClinician(): Promise<CallerClinician | null> {
  const supabase = createServerSupabase();

  // getUser(), NOT getSession().
  //
  // getSession() decodes the cookie without contacting the auth server, so a
  // forged or expired token still yields a user object. getUser() validates
  // the JWT server-side. The extra round-trip is the point: this value decides
  // whether a request may write to a patient chart.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) return null;

  // Primary key lookup -- clinicians.id IS auth.users.id (0002_clinicians.sql).
  //
  // maybeSingle() rather than single(): a missing row is an expected state,
  // not an exception. The step-4 trigger provisions on insert and on metadata
  // change, but it swallows its own failures by design so it can never block
  // an auth write. A user whose provisioning failed lands here with no row and
  // is denied everywhere, which is the safe direction.
  const { data, error } = await supabase
    .from("clinicians")
    .select("id, role, hospital_id")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data) return null;

  // The database CHECK constraint already restricts role to doctor|staff, but
  // parseRole re-narrows for TypeScript: Supabase returns the column as an
  // untyped string, and an unchecked cast here would let a future third role
  // flow into getPermissions() as though it were valid.
  const role = parseRole(data.role);
  if (!role) return null;

  return {
    userId: user.id,
    role,
    hospitalId: data.hospital_id as string,
  };
}

/**
 * Convenience for the common gate: resolve the caller and require "doctor".
 *
 * Returns the caller on success, or null to deny. Deliberately does not
 * distinguish "not signed in" from "signed in as staff" -- both are a 403 to
 * the client, and collapsing them keeps route code to a single branch.
 */
export async function requireDoctor(): Promise<CallerClinician | null> {
  const caller = await getCallerClinician();
  return caller?.role === "doctor" ? caller : null;
}
