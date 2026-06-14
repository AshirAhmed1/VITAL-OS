/**
 * Build patient PATCH payloads from parsed voice commands.
 */

import type { ChartNote, DemoMedication, DemoPatient, PatientProblem } from "@/lib/demo-patients";
import type { ParsedPatientCommand } from "@/lib/patient-command-parser";

export type UndoSnapshot = {
  patientId: string;
  patch: Record<string, unknown>;
  description: string;
};

function normalizeMedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findMedication(meds: DemoMedication[], name: string): DemoMedication | undefined {
  const key = normalizeMedName(name);
  return meds.find((m) => normalizeMedName(m.name).includes(key) || key.includes(normalizeMedName(m.name)));
}

function symptomProblems(patient: DemoPatient): PatientProblem[] {
  return (patient.problems ?? []).filter((p) => p.since === "Symptom");
}

function diagnosisProblems(patient: DemoPatient): PatientProblem[] {
  return (patient.problems ?? []).filter((p) => p.since !== "Symptom");
}

export function buildPatientSummary(patient: DemoPatient): string {
  const meds =
    patient.medications.map((m) => `${m.name} (${m.sig})`).join(", ") || "none";
  const symptoms =
    patient.symptoms?.length
      ? patient.symptoms.join(", ")
      : symptomProblems(patient).map((s) => s.name).join(", ") || "none";
  const status = patient.encounterStatus ?? "Not set";
  return [
    `Summary for ${patient.name}.`,
    `Age ${patient.age}, ${patient.sex}.`,
    `Room ${patient.room}.`,
    `Chief concern: ${patient.chiefConcern}.`,
    `Status: ${status}.`,
    `Medications: ${meds}.`,
    `Symptoms: ${symptoms}.`,
  ].join(" ");
}

export function applyParsedCommandToPatient(
  patient: DemoPatient,
  parsed: ParsedPatientCommand,
  providerName: string
): { patch: Record<string, unknown>; message: string; undo?: UndoSnapshot } | null {
  switch (parsed.intent) {
    case "addMedication": {
      if (!parsed.medication) return null;
      const existing = findMedication(patient.medications, parsed.medication);
      if (existing) {
        return {
          patch: {},
          message: `${parsed.medication} is already on ${patient.name}'s medication list.`,
        };
      }
      const medications = [
        ...patient.medications,
        { name: parsed.medication, sig: parsed.dosage ?? "sig not specified" },
      ];
      return {
        patch: { medications },
        message: `Added ${parsed.medication} to ${patient.name}'s chart.`,
        undo: {
          patientId: patient.id,
          patch: { medications: patient.medications },
          description: `medication add (${parsed.medication})`,
        },
      };
    }
    case "removeMedication": {
      if (!parsed.medication) return null;
      const target = findMedication(patient.medications, parsed.medication);
      if (!target) {
        return {
          patch: {},
          message: `Could not find ${parsed.medication} on ${patient.name}'s medication list.`,
        };
      }
      const medications = patient.medications.filter((m) => m !== target);
      return {
        patch: { medications },
        message: `Removed ${target.name} from ${patient.name}'s chart.`,
        undo: {
          patientId: patient.id,
          patch: { medications: patient.medications },
          description: `medication remove (${target.name})`,
        },
      };
    }
    case "replaceMedication": {
      if (!parsed.medication || !parsed.replaceWithMedication) return null;
      const target = findMedication(patient.medications, parsed.medication);
      if (!target) {
        return {
          patch: {},
          message: `Could not find ${parsed.medication} to replace.`,
        };
      }
      const medications = patient.medications.map((m) =>
        m === target ? { name: parsed.replaceWithMedication!, sig: m.sig } : m
      );
      return {
        patch: { medications },
        message: `Replaced ${parsed.medication} with ${parsed.replaceWithMedication} for ${patient.name}.`,
        undo: {
          patientId: patient.id,
          patch: { medications: patient.medications },
          description: `medication replace (${parsed.medication})`,
        },
      };
    }
    case "updateMedicationDosage": {
      if (!parsed.medication || !parsed.dosage) return null;
      const target = findMedication(patient.medications, parsed.medication);
      if (!target) {
        return {
          patch: {},
          message: `Could not find ${parsed.medication} on ${patient.name}'s medication list.`,
        };
      }
      const medications = patient.medications.map((m) =>
        m === target ? { ...m, sig: parsed.dosage! } : m
      );
      return {
        patch: { medications },
        message: `Updated ${parsed.medication} dosage to ${parsed.dosage} for ${patient.name}.`,
        undo: {
          patientId: patient.id,
          patch: { medications: patient.medications },
          description: `medication dosage (${parsed.medication})`,
        },
      };
    }
    case "updateChiefConcern": {
      if (!parsed.chiefConcern) return null;
      return {
        patch: { chiefConcern: parsed.chiefConcern },
        message: `Chief concern updated to ${parsed.chiefConcern} for ${patient.name}.`,
        undo: {
          patientId: patient.id,
          patch: { chiefConcern: patient.chiefConcern },
          description: "chief concern",
        },
      };
    }
    case "moveRoom": {
      if (!parsed.room) return null;
      const room = parsed.room.match(/^room\s+/i) ? parsed.room : `Room ${parsed.room}`;
      return {
        patch: { room },
        message: `Moved ${patient.name} to ${room}.`,
        undo: {
          patientId: patient.id,
          patch: { room: patient.room },
          description: "room assignment",
        },
      };
    }
    case "updateStatus": {
      if (!parsed.status) return null;
      return {
        patch: { encounterStatus: parsed.status },
        message: `Marked ${patient.name} as ${parsed.status}.`,
        undo: {
          patientId: patient.id,
          patch: { encounterStatus: patient.encounterStatus ?? null },
          description: "status",
        },
      };
    }
    case "addSymptom": {
      if (!parsed.symptom) return null;
      const symptoms = symptomProblems(patient);
      const exists = symptoms.some(
        (s) => normalizeMedName(s.name) === normalizeMedName(parsed.symptom!)
      );
      if (exists) {
        return {
          patch: {},
          message: `${parsed.symptom} is already documented for ${patient.name}.`,
        };
      }
      const newSymptom: PatientProblem = {
        name: parsed.symptom,
        status: "Active",
        since: "Symptom",
      };
      const problems = [...diagnosisProblems(patient), ...symptoms, newSymptom];
      return {
        patch: { problems },
        message: `Added symptom ${parsed.symptom} for ${patient.name}.`,
        undo: {
          patientId: patient.id,
          patch: { problems: patient.problems ?? [] },
          description: `symptom add (${parsed.symptom})`,
        },
      };
    }
    case "removeSymptom": {
      if (!parsed.symptom) return null;
      const symptoms = symptomProblems(patient);
      const key = normalizeMedName(parsed.symptom);
      const remaining = symptoms.filter((s) => normalizeMedName(s.name) !== key);
      if (remaining.length === symptoms.length) {
        return {
          patch: {},
          message: `Could not find symptom ${parsed.symptom} for ${patient.name}.`,
        };
      }
      const problems = [...diagnosisProblems(patient), ...remaining];
      return {
        patch: { problems },
        message: `Removed symptom ${parsed.symptom} from ${patient.name}'s chart.`,
        undo: {
          patientId: patient.id,
          patch: { problems: patient.problems ?? [] },
          description: `symptom remove (${parsed.symptom})`,
        },
      };
    }
    case "updateSymptomStatus": {
      if (!parsed.symptom || !parsed.symptomStatus) return null;
      const symptoms = symptomProblems(patient);
      const key = normalizeMedName(parsed.symptom);
      let found = false;
      const updated = symptoms.map((s) => {
        if (normalizeMedName(s.name).includes(key) || key.includes(normalizeMedName(s.name))) {
          found = true;
          return { ...s, status: parsed.symptomStatus! };
        }
        return s;
      });
      if (!found) {
        return {
          patch: {},
          message: `Could not find symptom ${parsed.symptom} for ${patient.name}.`,
        };
      }
      const problems = [...diagnosisProblems(patient), ...updated];
      return {
        patch: { problems },
        message: `Marked ${parsed.symptom} as ${parsed.symptomStatus} for ${patient.name}.`,
        undo: {
          patientId: patient.id,
          patch: { problems: patient.problems ?? [] },
          description: `symptom status (${parsed.symptom})`,
        },
      };
    }
    case "addChartNote": {
      if (!parsed.chartNote) return null;
      const note: ChartNote = {
        text: parsed.chartNote,
        timestamp: new Date().toISOString(),
        provider: providerName,
      };
      const chartNotes = [...(patient.chartNotes ?? []), note];
      return {
        patch: { chartNotes },
        message: `Chart note added for ${patient.name}.`,
        undo: {
          patientId: patient.id,
          patch: { chartNotes: patient.chartNotes ?? [] },
          description: "chart note",
        },
      };
    }
    case "patientSummary":
      return {
        patch: {},
        message: buildPatientSummary(patient),
      };
    default:
      return null;
  }
}

export const DISCHARGE_REASONS = [
  "Recovered",
  "Transfer",
  "Left against medical advice",
  "Deceased",
  "Other",
] as const;

export function parseDischargeReason(text: string): string | null {
  const cleaned = text.trim();
  const q = cleaned.toLowerCase();
  if (/recovered|recovery|fully well|doing well|better now|stable for discharge/.test(q)) {
    return "Recovered";
  }
  if (/transfer|transferred|another facility|hospital transfer|sent home/.test(q)) {
    return "Transfer";
  }
  if (/ama|against medical advice|left against/.test(q)) {
    return "Left against medical advice";
  }
  if (/deceased|death|expired|passed away/.test(q)) {
    return "Deceased";
  }
  if (/\bother\b/.test(q)) return "Other";

  for (const reason of DISCHARGE_REASONS) {
    if (q.includes(reason.toLowerCase())) return reason;
  }

  const exact = DISCHARGE_REASONS.find((r) => r.toLowerCase() === q);
  if (exact) return exact;

  const reasonIsMatch = q.match(
    /(?:reason is|because|due to|discharge reason(?: is)?)\s+(.+)/i
  );
  if (reasonIsMatch?.[1]?.trim()) {
    return parseDischargeReason(reasonIsMatch[1]) ?? reasonIsMatch[1].trim();
  }

  if (cleaned.length > 2) return cleaned;
  return null;
}
