"use client";

import * as React from "react";
import { ArrowLeft, Eye, EyeOff, Shield, Stethoscope, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { VitalLogo } from "@/components/vital-logo";
import {
  INVALID_DOCTOR_LOGIN_MESSAGE,
  INVALID_STAFF_LOGIN_MESSAGE,
  useAuth,
} from "@/components/auth-provider";
import type { VitalRole } from "@/lib/auth";

const ROLE_OPTIONS: Array<{
  role: VitalRole;
  title: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    role: "doctor",
    title: "Doctor",
    description: "Sign in with your Doctor ID and username.",
    icon: <Stethoscope className="h-5 w-5 text-muted-foreground" aria-hidden />,
  },
  {
    role: "staff",
    title: "Staff",
    description: "Sign in with your Staff ID and username.",
    icon: <UserRound className="h-5 w-5 text-muted-foreground" aria-hidden />,
  },
];

type LoginStep = "role" | "doctor" | "staff";

const CREDENTIAL_FORMS: Record<
  Exclude<LoginStep, "role">,
  {
    signInLabel: string;
    heading: string;
    idLabel: string;
    idPlaceholder: string;
    invalidMessage: string;
  }
> = {
  doctor: {
    signInLabel: "Doctor sign-in",
    heading: "Enter your Doctor ID",
    idLabel: "Doctor ID",
    idPlaceholder: "Enter your Doctor ID",
    invalidMessage: INVALID_DOCTOR_LOGIN_MESSAGE,
  },
  staff: {
    signInLabel: "Staff sign-in",
    heading: "Enter your Staff ID",
    idLabel: "Staff ID",
    idPlaceholder: "Enter your Staff ID",
    invalidMessage: INVALID_STAFF_LOGIN_MESSAGE,
  },
};

export function LoginScreen() {
  const { loginDoctor, loginStaff } = useAuth();
  const [step, setStep] = React.useState<LoginStep>("role");
  const [fullName, setFullName] = React.useState("");
  const [credentialId, setCredentialId] = React.useState("");
  const [showCredentialId, setShowCredentialId] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const handleRoleSelect = (role: VitalRole) => {
    setError(null);
    setFullName("");
    setCredentialId("");
    setShowCredentialId(false);
    if (role === "doctor") {
      setStep("doctor");
      return;
    }
    setStep("staff");
  };

  const handleCredentialLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (step === "role") return;

    const form = CREDENTIAL_FORMS[step];
    setError(null);
    const name = fullName.trim();
    const id = credentialId.trim();
    if (!name || !id) {
      setError(form.invalidMessage);
      return;
    }
    setSubmitting(true);
    const ok =
      step === "doctor" ? loginDoctor(name, id) : loginStaff(name, id);
    setSubmitting(false);
    if (!ok) {
      setError(form.invalidMessage);
    }
  };

  const handleBack = () => {
    setStep("role");
    setError(null);
    setFullName("");
    setCredentialId("");
    setShowCredentialId(false);
  };

  const credentialForm = step !== "role" ? CREDENTIAL_FORMS[step] : null;

  return (
    <main className="relative min-h-screen bg-background text-foreground" suppressHydrationWarning>
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1480px] flex-col items-center justify-center gap-4 px-4 py-5 lg:px-8 lg:py-7">
        <div className="vital-card flex w-full max-w-lg flex-col items-center gap-6 px-8 py-10 text-center">
          <VitalLogo
            className="h-11 w-auto"
            textClassName="text-lg font-medium tracking-tight text-foreground"
          />
          {step === "role" ? (
            <>
              <div className="space-y-2">
                <p className="vital-footnote uppercase tracking-[0.16em]">
                  Secure sign-in
                </p>
                <h1 className="vital-h1 text-xl">Choose your role</h1>
                <p className="vital-body">
                  Select how you are using VITAL OS on this device.
                </p>
              </div>
              <div className="grid w-full gap-3 sm:grid-cols-2">
                {ROLE_OPTIONS.map((option) => (
                  <button
                    key={option.role}
                    type="button"
                    onClick={() => handleRoleSelect(option.role)}
                    className="group flex h-auto min-h-[9.5rem] flex-col items-start gap-3 rounded-lg border border-border bg-card px-4 py-4 text-left transition-colors hover:border-primary/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                      {option.icon}
                      {option.title}
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : credentialForm ? (
            <>
              <div className="w-full space-y-2 text-center">
                <p className="vital-footnote uppercase tracking-[0.16em]">
                  {credentialForm.signInLabel}
                </p>
                <h1 className="vital-h1 text-xl">{credentialForm.heading}</h1>
                <p className="vital-body">
                  Demo credentials only — use your assigned username and ID.
                </p>
              </div>
              <form
                onSubmit={handleCredentialLogin}
                className="flex w-full flex-col gap-5 text-left"
              >
                <label className="space-y-1.5">
                  <span className="vital-label">Username</span>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => {
                      setFullName(e.target.value);
                      setError(null);
                    }}
                    autoComplete="username"
                    placeholder="Enter your username"
                    className="vital-input"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="vital-label">{credentialForm.idLabel}</span>
                  <div className="relative">
                    <input
                      type={showCredentialId ? "text" : "password"}
                      inputMode="numeric"
                      value={credentialId}
                      onChange={(e) => {
                        setCredentialId(e.target.value);
                        setError(null);
                      }}
                      autoComplete="off"
                      placeholder={credentialForm.idPlaceholder}
                      className="vital-input pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCredentialId((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
                      aria-label={showCredentialId ? "Hide ID" : "Show ID"}
                    >
                      {showCredentialId ? (
                        <EyeOff className="h-4 w-4" aria-hidden />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                  </div>
                </label>
                {error ? (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {error}
                  </p>
                ) : null}
                <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleBack}
                    className="inline-flex items-center gap-2"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    Back
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting ? "Signing in…" : "Login"}
                  </Button>
                </div>
              </form>
            </>
          ) : null}
          <p className="vital-footnote flex items-center justify-center gap-2">
            <Shield className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            Demo workstation sign-in — not for production use.
          </p>
        </div>
      </div>
    </main>
  );
}
