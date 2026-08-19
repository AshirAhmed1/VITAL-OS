"use client";

import * as React from "react";
import { Eye, EyeOff, Shield } from "lucide-react";

import { Button } from "@/components/ui/button";
import { VitalLogo } from "@/components/vital-logo";
import { useAuth } from "@/components/auth-provider";

export function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Enter your email and password.");
      return;
    }

    setSubmitting(true);
    const result = await login(trimmedEmail, password);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.message);
      setPassword("");
    }
  };

  return (
    <main
      className="relative min-h-screen bg-background text-foreground"
      suppressHydrationWarning
    >
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1480px] flex-col items-center justify-center gap-4 px-4 py-5 lg:px-8 lg:py-7">
        <div className="vital-card flex w-full max-w-lg flex-col items-center gap-6 px-8 py-10 text-center">
          <VitalLogo
            className="h-11 w-auto"
            textClassName="text-lg font-medium tracking-tight text-foreground"
          />

          <div className="w-full space-y-2 text-center">
            <p className="vital-footnote uppercase tracking-[0.16em]">
              Secure sign-in
            </p>
            <h1 className="vital-h1 text-xl">Sign in to VITAL OS</h1>
            <p className="vital-body">
              Use the credentials issued for your clinical account.
            </p>
          </div>

          <form
            onSubmit={handleLogin}
            className="flex w-full flex-col gap-5 text-left"
          >
            <label className="space-y-1.5">
              <span className="vital-label">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                autoComplete="username"
                placeholder="you@hospital.org"
                className="vital-input"
              />
            </label>

            <label className="space-y-1.5">
              <span className="vital-label">Password</span>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  className="vital-input pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>
            </label>

            {error ? (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            ) : null}

            <Button type="submit" disabled={submitting} className="mt-1">
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <p className="vital-footnote flex items-center justify-center gap-2">
            <Shield className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            Your role and permissions come from your account.
          </p>
        </div>
      </div>
    </main>
  );
}
