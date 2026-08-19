"use client";

import * as React from "react";

import type { Session, User } from "@supabase/supabase-js";

import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  DEMO_HOSPITAL_ID,
  DEMO_HOSPITAL_NAME,
  getPermissions,
  parseRole,
  type VitalPermissions,
  type VitalRole,
  type VitalUser,
} from "@/lib/auth";

export type { VitalRole, VitalUser, VitalPermissions };
export {
  ACCESS_RESTRICTED_MESSAGE,
  AI_ASSISTANT_RESTRICTED_MESSAGE,
  INVALID_LOGIN_MESSAGE,
} from "@/lib/auth";

export type LoginResult = { ok: true } | { ok: false; message: string };

type AuthContextValue = {
  user: VitalUser | null;
  role: VitalRole | null;
  permissions: VitalPermissions;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  hydrated: boolean;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

const MISSING_ROLE_MESSAGE =
  "This account has no clinical role assigned. Contact your administrator.";

function readString(
  meta: Record<string, unknown>,
  key: string
): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Project a Supabase user onto the app's VitalUser shape.
 *
 * Role and display name come from `user_metadata`, set at account creation.
 * Note that `user_metadata` is writable by the account holder — it is a
 * convenience source for UI, not an authorization boundary. The authoritative
 * role moves to the `clinicians` table in M2, where RLS protects it.
 */
export function toVitalUser(user: User | null | undefined): VitalUser | null {
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;

  const role = parseRole(meta.role);
  if (!role) return null;

  return {
    userId: user.id,
    userName: readString(meta, "full_name") ?? user.email ?? "Clinician",
    role,
    doctorId: role === "doctor" ? readString(meta, "doctor_id") : undefined,
    staffId: role === "staff" ? readString(meta, "staff_id") : undefined,
    hospitalId: DEMO_HOSPITAL_ID,
    hospitalName: DEMO_HOSPITAL_NAME,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const supabase = React.useMemo(() => createBrowserSupabase(), []);
  const [user, setUser] = React.useState<VitalUser | null>(null);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    let active = true;

    const applySession = (session: Session | null) => {
      if (!active) return;
      setUser(toVitalUser(session?.user));
    };

    void supabase.auth.getSession().then(({ data }) => {
      applySession(data.session);
      if (active) setHydrated(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        applySession(session);
      }
    );

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [supabase]);

  const login = React.useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        return { ok: false, message: error.message };
      }

      // An account without a role cannot be gated correctly, so refuse the
      // session rather than admitting a user the permission model can't place.
      if (!toVitalUser(data.user)) {
        await supabase.auth.signOut();
        return { ok: false, message: MISSING_ROLE_MESSAGE };
      }

      return { ok: true };
    },
    [supabase]
  );

  const logout = React.useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
  }, [supabase]);

  const role = user?.role ?? null;
  const permissions = getPermissions(role);

  return (
    <AuthContext.Provider
      value={{ user, role, permissions, login, logout, hydrated }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
