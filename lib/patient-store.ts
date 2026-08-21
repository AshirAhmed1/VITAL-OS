/**
 * Patient roster persistence via Supabase (demo / single-tenant).
 */

import {
  DEMO_PATIENTS,
  patientToSnapshot,
  type DemoPatient,
} from "@/lib/demo-patients";
import {
  demoPatientToRow,
  patchToRowUpdate,
  payloadToDemoPatient,
  rowToDemoPatient,
  type PatientRow,
} from "@/lib/patient-db";
import { createServerSupabase } from "@/lib/supabase/server";

export type PatientStoreEvent =
  | { action: "created"; patientId: string }
  | { action: "updated"; patientId: string }
  | { action: "deleted"; patientId: string }
  | { action: "listed" }
  | { action: "read"; patientId: string };

function slugFromName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28);
  return s || "patient";
}

function newPatientId(name: string): string {
  return `pt-${slugFromName(name)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newMrn(): string {
  return `MRN-${Date.now().toString(36).toUpperCase()}`;
}

async function seedDemoPatientsIfEmpty(): Promise<void> {
  const supabase = createServerSupabase();
  const { count, error: countError } = await supabase
    .from("patients")
    .select("id", { count: "exact", head: true });

  if (countError) throw countError;
  if ((count ?? 0) > 0) return;

  const rows = (DEMO_PATIENTS as DemoPatient[]).map((p) => demoPatientToRow(p));
  let { error } = await supabase.from("patients").insert(rows);
  if (error && isMissingColumnError(error)) {
    const stripped = rows.map((r) => stripOptionalPatientColumns(r));
    ({ error } = await supabase.from("patients").insert(stripped as typeof rows));
  }
  if (error) throw error;
}

function isDischargedStatus(status: string | null | undefined): boolean {
  return /^discharged$/i.test((status ?? "").trim());
}

function isMissingColumnError(error: {
  message?: string;
  code?: string;
}): boolean {
  if (error.code === "PGRST204") return true;
  const msg = (error.message ?? "").toLowerCase();
  return (
    /column/.test(msg) &&
    (/does not exist|could not find|unknown|schema cache/.test(msg) ||
      /discharged_at|discharge_reason|discharged_by|chart_notes/.test(msg))
  );
}

function stripOptionalPatientColumns(
  rowPatch: Partial<PatientRow>
): Partial<PatientRow> {
  // clinician_id and hospital_id are deliberately NOT stripped. They are M2
  // schema, guaranteed present by 0005_patients_tenancy.sql, and dropping
  // clinician_id on a retry would silently create an unattributed patient --
  // exactly the failure the chart_notes retry produced before
  // add_patient_voice_fields.sql was applied.
  const { chart_notes, discharged_at, discharge_reason, discharged_by, ...rest } =
    rowPatch;
  return rest;
}

function filterActiveRows(rows: PatientRow[]): PatientRow[] {
  return rows.filter(
    (r) => !r.discharged_at && !isDischargedStatus(r.status)
  );
}

function filterDischargedRows(rows: PatientRow[]): PatientRow[] {
  return rows.filter(
    (r) => Boolean(r.discharged_at) || isDischargedStatus(r.status)
  );
}

async function fetchAllRows(activeOnly = true): Promise<PatientRow[]> {
  const supabase = createServerSupabase();
  await seedDemoPatientsIfEmpty();

  let query = supabase.from("patients").select("*").order("name", { ascending: true });
  if (activeOnly) {
    query = query.is("discharged_at", null);
  }

  const { data, error } = await query;
  if (error) {
    if (/discharged_at/.test(error.message)) {
      const fallback = await supabase
        .from("patients")
        .select("*")
        .order("name", { ascending: true });
      if (fallback.error) throw fallback.error;
      const rows = (fallback.data ?? []) as PatientRow[];
      return activeOnly ? filterActiveRows(rows) : rows;
    }
    throw error;
  }
  const rows = (data ?? []) as PatientRow[];
  if (activeOnly) {
    return rows.filter((r) => !isDischargedStatus(r.status));
  }
  return rows;
}

export async function listPatients(): Promise<DemoPatient[]> {
  const rows = await fetchAllRows(true);
  return rows.map(rowToDemoPatient);
}

export async function listDischargedPatients(): Promise<DemoPatient[]> {
  const supabase = createServerSupabase();
  await seedDemoPatientsIfEmpty();
  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .not("discharged_at", "is", null)
    .order("discharged_at", { ascending: false });

  if (error) {
    if (/discharged_at/.test(error.message)) {
      const fallback = await supabase
        .from("patients")
        .select("*")
        .order("name", { ascending: true });
      if (fallback.error) throw fallback.error;
      return filterDischargedRows((fallback.data ?? []) as PatientRow[]).map(
        rowToDemoPatient
      );
    }
    throw error;
  }
  const rows = (data ?? []) as PatientRow[];
  return rows
    .filter((r) => Boolean(r.discharged_at) || isDischargedStatus(r.status))
    .map(rowToDemoPatient);
}

export async function getPatientById(id: string): Promise<DemoPatient | undefined> {
  const idTrim = id.trim();
  const supabase = createServerSupabase();
  await seedDemoPatientsIfEmpty();

  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .eq("id", idTrim)
    .maybeSingle();

  if (error) throw error;
  if (!data) return undefined;
  return rowToDemoPatient(data as PatientRow);
}

export async function getPatientByMrn(mrn: string): Promise<DemoPatient | undefined> {
  const norm = mrn.trim().toUpperCase();
  const patients = await listPatients();
  return patients.find((p) => p.mrn.trim().toUpperCase() === norm);
}

export async function createPatientFromPayload(
  body: unknown,
  /**
   * Admitting clinician's uuid (auth.users.id, which is also clinicians.id).
   *
   * Comes from getCallerClinician() in the route, never from the request body:
   * a client-supplied attribution is not an attribution. Optional so the
   * signature stays compatible with callers that have no caller context --
   * seedDemoPatientsIfEmpty() admits nobody.
   */
  clinicianId?: string
): Promise<{ patient: DemoPatient; event: PatientStoreEvent }> {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = String(o.name ?? "").trim();
  if (!name) {
    throw new Error("name is required");
  }

  const id = newPatientId(name);
  const mrn = String(o.mrn ?? "").trim() || newMrn();
  const patient = payloadToDemoPatient(o, id, mrn);
  const row = {
    ...demoPatientToRow(patient),
    // hospital_id is deliberately absent: it takes the column default from
    // 0005_patients_tenancy.sql. Setting it here from caller.hospitalId would
    // look more correct and be less safe -- it would put a client-influenced
    // value where a fixed default currently sits, and M3's RLS WITH CHECK is
    // the right place to bind tenancy to the caller.
    ...(clinicianId ? { clinician_id: clinicianId } : {}),
  };

  console.log("[PATIENT CREATE] Parsed payload / insert row:", {
    id: row.id,
    mrn: row.mrn,
    name: row.name,
    age: row.age,
    sex: row.sex,
    room: row.room,
    chief_concern: row.chief_concern,
    medications: row.medications,
    allergies: row.allergies,
    problems: row.problems,
    acuity: row.acuity,
    status: row.status,
    dob: row.dob,
    last_visit: row.last_visit,
    blood_type: row.blood_type,
    emergency_contact: row.emergency_contact,
    chart_notes: row.chart_notes,
    discharged_at: row.discharged_at,
    clinician_id: row.clinician_id ?? null,
  });

  const supabase = createServerSupabase();
  let { data, error } = await supabase
    .from("patients")
    .insert(row)
    .select("*")
    .single();

  // Live DBs may not have optional voice-field columns yet (chart_notes, discharged_*).
  // Mirror updatePatientById: strip those columns and retry once.
  if (error && isMissingColumnError(error)) {
    console.warn(
      "[PATIENT CREATE] Missing optional column; retrying without chart_notes/discharged_*:",
      {
        message: error.message,
        code: error.code,
      }
    );
    const stripped = stripOptionalPatientColumns(row);
    ({ data, error } = await supabase
      .from("patients")
      .insert(stripped as typeof row)
      .select("*")
      .single());
  }

  if (error) {
    console.error("[SUPABASE INSERT ERROR]", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error(
      [
        error.message,
        error.code ? `code=${error.code}` : null,
        error.details ? `details=${error.details}` : null,
        error.hint ? `hint=${error.hint}` : null,
      ]
        .filter(Boolean)
        .join(" | ")
    );
  }
  const created = rowToDemoPatient(data as PatientRow);
  return { patient: created, event: { action: "created", patientId: created.id } };
}

async function tryUpdateRow(
  idTrim: string,
  rowPatch: Partial<PatientRow>
): Promise<{ ok: true; row: PatientRow } | { ok: false; missingColumn: boolean; error: Error }> {
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("patients")
    .update(rowPatch)
    .eq("id", idTrim)
    .select("*")
    .single();

  if (!error && data) {
    return { ok: true, row: data as PatientRow };
  }
  const err = error ?? new Error("Update failed.");
  return {
    ok: false,
    missingColumn: isMissingColumnError(err),
    error: err instanceof Error ? err : new Error(String(err)),
  };
}

async function appendDischargeProblemNote(
  idTrim: string,
  current: DemoPatient,
  reason: string,
  providerName: string
): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  const dischargeProblem = {
    name: "Discharge summary",
    status: reason,
    since: `${providerName} · ${stamp}`,
  };
  const existing = current.problems ?? [];
  const alreadyNoted = existing.some((p) =>
    /^discharge summary$/i.test(p.name)
  );
  if (alreadyNoted) return;

  await updatePatientById(idTrim, {
    problems: [...existing, dischargeProblem],
  });
}

export async function updatePatientById(
  id: string,
  patch: unknown
): Promise<{ patient: DemoPatient; event: PatientStoreEvent } | null> {
  const idTrim = id.trim();
  const o =
    patch && typeof patch === "object"
      ? (patch as Record<string, unknown>)
      : {};

  if (o.discharge === true) {
    const reason = String(o.dischargeReason ?? "Other").trim() || "Other";
    const providerName = String(o.dischargedBy ?? "Provider").trim() || "Provider";
    return dischargePatientById(idTrim, reason, providerName);
  }

  const current = await getPatientById(idTrim);
  if (!current) return null;

  const rowPatch = patchToRowUpdate(o, current);
  if (Object.keys(rowPatch).length === 0) {
    return { patient: current, event: { action: "updated", patientId: current.id } };
  }

  let attempt: Partial<PatientRow> = rowPatch;
  for (let i = 0; i < 3; i++) {
    const result = await tryUpdateRow(idTrim, attempt);
    if (result.ok) {
      const updated = rowToDemoPatient(result.row);
      return { patient: updated, event: { action: "updated", patientId: updated.id } };
    }
    if (!result.missingColumn || i >= 2) {
      throw result.error;
    }
    attempt = stripOptionalPatientColumns(attempt);
    if (Object.keys(attempt).length === 0) {
      throw result.error;
    }
  }

  throw new Error("Failed to update patient.");
}

export async function dischargePatientById(
  id: string,
  reason: string,
  providerName: string
): Promise<{ patient: DemoPatient; event: PatientStoreEvent } | null> {
  const idTrim = id.trim();
  const current = await getPatientById(idTrim);
  if (!current) return null;

  const fullPatch = patchToRowUpdate(
    {
      discharge: true,
      dischargeReason: reason,
      dischargedBy: providerName,
      encounterStatus: "Discharged",
    },
    current
  );

  const attempts: Partial<PatientRow>[] = [
    fullPatch,
    stripOptionalPatientColumns(fullPatch),
    { status: "Discharged" },
  ];

  for (const attempt of attempts) {
    if (Object.keys(attempt).length === 0) continue;
    const result = await tryUpdateRow(idTrim, attempt);
    if (result.ok) {
      if (!attempt.discharged_at) {
        try {
          await appendDischargeProblemNote(idTrim, current, reason, providerName);
        } catch {
          /* discharge status saved; note is best-effort */
        }
      }
      const refreshed = await getPatientById(idTrim);
      const patient = refreshed ?? rowToDemoPatient(result.row);
      return { patient, event: { action: "updated", patientId: idTrim } };
    }
    if (!result.missingColumn) {
      break;
    }
  }

  const deleted = await deletePatientById(idTrim);
  if (!deleted) return null;
  return {
    patient: {
      ...current,
      encounterStatus: "Discharged",
      dischargeReason: reason,
      dischargedBy: providerName,
      dischargedAt: new Date().toISOString(),
    },
    event: { action: "deleted", patientId: idTrim },
  };
}

export async function deletePatientById(
  id: string
): Promise<{ event: PatientStoreEvent } | null> {
  const idTrim = id.trim();
  const supabase = createServerSupabase();

  const { data, error } = await supabase
    .from("patients")
    .delete()
    .eq("id", idTrim)
    .select("id");

  if (error) throw error;
  if (!data?.length) return null;
  return { event: { action: "deleted", patientId: idTrim } };
}

export function summarizePatientsForTools(patients: DemoPatient[]): string {
  if (!patients.length) return "No patients in roster.";
  return patients
    .map(
      (p) =>
        `${p.id} | ${p.mrn} | ${p.name} | ${p.age}${p.sex} | ${p.chiefConcern.slice(0, 80)}`
    )
    .join("\n");
}

export function summarizePatientDetail(p: DemoPatient): string {
  return patientToSnapshot(p);
}

function snakeToCreatePayload(
  a: Record<string, unknown>
): Record<string, unknown> {
  const g = (k: string) => a[k];
  return {
    name: g("name"),
    mrn: g("mrn"),
    preferredName: g("preferred_name"),
    age: g("age"),
    sex: g("sex"),
    dob: g("dob"),
    bloodType: g("blood_type") ?? g("bloodType"),
    room: g("room"),
    triageAcuity: g("triage_acuity") ?? g("triageAcuity") ?? g("acuity"),
    allergies: g("allergies"),
    chiefConcern: g("chief_concern") ?? g("chiefConcern"),
    diagnoses: g("diagnoses"),
    problems: g("problems"),
    medications: g("medications"),
    lastVisit: g("last_visit") ?? g("lastVisit"),
    pcp: g("pcp") ?? g("provider"),
    emergencyContact: g("emergency_contact") ?? g("emergencyContact"),
    primaryContactLine: g("primary_contact_line") ?? g("primaryContactLine"),
    status: g("status"),
  };
}

function snakeToPatchPayload(
  a: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (snake: string, camel: string) => {
    if (a[snake] !== undefined) out[camel] = a[snake];
    if (a[camel] !== undefined) out[camel] = a[camel];
  };
  copy("name", "name");
  copy("mrn", "mrn");
  copy("age", "age");
  copy("sex", "sex");
  copy("dob", "dob");
  copy("blood_type", "bloodType");
  copy("room", "room");
  copy("triage_acuity", "triageAcuity");
  copy("acuity", "triageAcuity");
  copy("allergies", "allergies");
  copy("chief_concern", "chiefConcern");
  copy("diagnoses", "diagnoses");
  copy("problems", "problems");
  copy("medications", "medications");
  copy("last_visit", "lastVisit");
  copy("pcp", "pcp");
  copy("provider", "pcp");
  copy("emergency_contact", "emergencyContact");
  copy("primary_contact_line", "primaryContactLine");
  copy("status", "status");
  copy("encounter_status", "encounterStatus");
  copy("encounterStatus", "encounterStatus");
  copy("chart_notes", "chartNotes");
  copy("chartNotes", "chartNotes");
  copy("discharged_at", "dischargedAt");
  copy("dischargedAt", "dischargedAt");
  copy("discharge_reason", "dischargeReason");
  copy("dischargeReason", "dischargeReason");
  copy("discharged_by", "dischargedBy");
  copy("dischargedBy", "dischargedBy");
  if (a.discharge !== undefined) out.discharge = a.discharge;
  return out;
}

export async function executePatientToolCall(
  name: string,
  rawArgs: string
): Promise<{ content: string; events: PatientStoreEvent[] }> {
  let args: Record<string, unknown>;
  try {
    const parsed = rawArgs?.trim() ? JSON.parse(rawArgs) : {};
    args =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return {
      content: JSON.stringify({ ok: false, error: "Invalid JSON in tool arguments." }),
      events: [],
    };
  }

  try {
    switch (name) {
      case "list_patients": {
        const pts = await listPatients();
        return {
          content: JSON.stringify({
            ok: true,
            count: pts.length,
            roster: summarizePatientsForTools(pts),
          }),
          events: [{ action: "listed" }],
        };
      }
      case "get_patient": {
        const pid = String(args.patient_id ?? args.patientId ?? "").trim();
        const mrn = String(args.mrn ?? "").trim();
        let p: DemoPatient | undefined;
        if (pid) p = await getPatientById(pid);
        if (!p && mrn) p = await getPatientByMrn(mrn);
        if (!p) {
          return {
            content: JSON.stringify({
              ok: false,
              error: "Patient not found for id/mrn provided.",
            }),
            events: [],
          };
        }
        return {
          content: JSON.stringify({
            ok: true,
            patient_id: p.id,
            detail: summarizePatientDetail(p),
          }),
          events: [{ action: "read", patientId: p.id }],
        };
      }
      case "create_patient": {
        const payload = snakeToCreatePayload(args);
        const { patient, event } = await createPatientFromPayload(payload);
        return {
          content: JSON.stringify({
            ok: true,
            patient_id: patient.id,
            mrn: patient.mrn,
            name: patient.name,
            message: "Created chart row.",
          }),
          events: [event],
        };
      }
      case "update_patient": {
        const pid = String(
          args.patient_id ?? args.patientId ?? ""
        ).trim();
        if (!pid) {
          return {
            content: JSON.stringify({
              ok: false,
              error: "patient_id is required.",
            }),
            events: [],
          };
        }
        const patch = snakeToPatchPayload(args);
        delete patch.patient_id;
        delete patch.patientId;
        const res = await updatePatientById(pid, patch);
        if (!res) {
          return {
            content: JSON.stringify({
              ok: false,
              error: `No patient with id ${pid}.`,
            }),
            events: [],
          };
        }
        return {
          content: JSON.stringify({
            ok: true,
            patient_id: res.patient.id,
            message: "Updated chart row.",
          }),
          events: [res.event],
        };
      }
      case "delete_patient": {
        const pid = String(
          args.patient_id ?? args.patientId ?? ""
        ).trim();
        if (!pid) {
          return {
            content: JSON.stringify({
              ok: false,
              error: "patient_id is required.",
            }),
            events: [],
          };
        }
        const res = await deletePatientById(pid);
        if (!res) {
          return {
            content: JSON.stringify({
              ok: false,
              error: `No patient with id ${pid}.`,
            }),
            events: [],
          };
        }
        return {
          content: JSON.stringify({
            ok: true,
            patient_id: pid,
            message: "Removed chart row from roster.",
          }),
          events: [res.event],
        };
      }
      default:
        return {
          content: JSON.stringify({ ok: false, error: `Unknown tool ${name}.` }),
          events: [],
        };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Tool failed.";
    return {
      content: JSON.stringify({ ok: false, error: msg }),
      events: [],
    };
  }
}
