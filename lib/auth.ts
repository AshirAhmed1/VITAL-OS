export type VitalRole = "doctor" | "staff";

export const DEMO_HOSPITAL_ID = "vital-demo-hospital";
export const DEMO_HOSPITAL_NAME = "VITAL Demo Hospital";

export const ACCESS_RESTRICTED_MESSAGE =
  "Access restricted. Please consult your supervising physician.";

export const AI_ASSISTANT_RESTRICTED_MESSAGE =
  "AI assistant access is restricted to doctors in this demo.";

export const API_AI_RESTRICTED_MESSAGE =
  "AI assistant access is restricted to doctors.";

export const INVALID_LOGIN_MESSAGE =
  "Invalid email or password. Please try again.";

export type VitalUser = {
  userId: string;
  userName: string;
  role: VitalRole;
  doctorId?: string;
  staffId?: string;
  hospitalId: string;
  hospitalName: string;
};

export type VitalPermissions = {
  canUseAI: boolean;
  canAdmitPatient: boolean;
  canDischargePatient: boolean;
  canEditPatientStatus: boolean;
  canCreateMedicationOrders: boolean;
  canViewReports: boolean;
  canViewAnalytics: boolean;
  canViewSettings: boolean;
};

export function formatDoctorDisplayName(userName: string): string {
  return `Dr. ${userName}`;
}

export function isVitalUser(value: unknown): value is VitalUser {
  if (!value || typeof value !== "object") return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.userId === "string" &&
    typeof u.userName === "string" &&
    (u.role === "doctor" || u.role === "staff") &&
    typeof u.hospitalId === "string" &&
    typeof u.hospitalName === "string" &&
    (u.doctorId === undefined || typeof u.doctorId === "string") &&
    (u.staffId === undefined || typeof u.staffId === "string")
  );
}

export function getPermissions(role: VitalRole | null): VitalPermissions {
  const isDoctor = role === "doctor";
  return {
    canUseAI: isDoctor,
    canAdmitPatient: isDoctor,
    canDischargePatient: isDoctor,
    canEditPatientStatus: isDoctor,
    canCreateMedicationOrders: isDoctor,
    canViewReports: isDoctor,
    canViewAnalytics: isDoctor,
    canViewSettings: isDoctor,
  };
}

export function parseRole(raw: unknown): VitalRole | null {
  return raw === "doctor" || raw === "staff" ? raw : null;
}

export function isRestrictedClinicalPatch(patch: unknown): boolean {
  if (!patch || typeof patch !== "object") return false;
  const keys = Object.keys(patch as Record<string, unknown>);
  return keys.some((k) =>
    [
      "problems",
      "edOrUrgentCourse",
      "triageAcuity",
      "chiefConcern",
      "medications",
      "allergies",
      "room",
      "age",
      "sex",
      "dob",
      "bloodType",
      "pcp",
      "status",
      "encounterStatus",
      "chartNotes",
      "emergencyContact",
      "primaryContactLine",
      "careTeam",
      "riskFlags",
      "discharge",
      "dischargedAt",
      "dischargeReason",
      "dischargedBy",
    ].includes(k)
  );
}

export const DOCTOR_ONLY_API_MESSAGE =
  "This action is restricted to doctors in this demo.";
