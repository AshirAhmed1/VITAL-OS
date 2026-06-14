/**
 * Strict patient identification tests — run with: npm run test:voice
 */

import assert from "node:assert/strict";

import type { DemoPatient } from "./demo-patients";
import {
  extractModificationPatientName,
  resolvePatientForModification,
} from "./patient-identification";

const sarahSmith: DemoPatient = {
  id: "pt-sarah-smith",
  mrn: "MRN-990001",
  name: "Sarah Smith",
  age: 40,
  sex: "F",
  dob: "1985-01-01",
  bloodType: "A+",
  room: "Room 10",
  triageAcuity: "CTAS 3",
  allergies: [],
  chiefConcern: "Chest pain",
  symptoms: [],
  diagnoses: [],
  medications: [],
  vitals: {},
  lastVisit: "2026-01-01",
  social: "",
  chartNote: "",
  emergencyContact: { name: "N/A", relationship: "N/A", phone: "N/A" },
  address: "N/A",
  insurance: "N/A",
};

const sarahHello: DemoPatient = {
  ...sarahSmith,
  id: "pt-sarah-hello",
  mrn: "MRN-990002",
  name: "Sarah Hello",
  room: "Room 11",
};

const roster = [sarahSmith, sarahHello];

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

test("exact full name discharge resolves Sarah Smith only", () => {
  const r = resolvePatientForModification(roster, {
    transcript: "Discharge Sarah Smith",
    patientHint: "Sarah Smith",
  });
  assert.equal(r.status, "matched");
  if (r.status === "matched") {
    assert.equal(r.patient.id, "pt-sarah-smith");
  }
});

test("exact full name move room resolves Sarah Smith only", () => {
  const r = resolvePatientForModification(roster, {
    transcript: "Move Sarah Smith to room 20",
    patientHint: "Sarah Smith",
  });
  assert.equal(r.status, "matched");
  if (r.status === "matched") {
    assert.equal(r.patient.name, "Sarah Smith");
  }
});

test("exact full name medication resolves Sarah Smith only", () => {
  const r = resolvePatientForModification(roster, {
    transcript: "Add Aspirin to Sarah Smith",
    patientHint: "Sarah Smith",
  });
  assert.equal(r.status, "matched");
  if (r.status === "matched") {
    assert.equal(r.patient.name, "Sarah Smith");
  }
});

test("partial first name Sarah is ambiguous", () => {
  const r = resolvePatientForModification(roster, {
    transcript: "Discharge Sarah",
    patientHint: "Sarah",
  });
  assert.equal(r.status, "ambiguous");
  if (r.status === "ambiguous") {
    assert.equal(r.patients.length, 2);
  }
});

test("partial first name does not match via substring on full name", () => {
  const r = resolvePatientForModification(roster, {
    transcript: "Discharge Sarah Smith",
    patientHint: "Sarah Smith",
  });
  assert.equal(r.status, "matched");
  if (r.status === "matched") {
    assert.notEqual(r.patient.id, "pt-sarah-hello");
  }
});

test("extractModificationPatientName from discharge command", () => {
  assert.equal(
    extractModificationPatientName("Discharge Sarah Smith"),
    "Sarah Smith"
  );
});

console.log("\nAll patient identification tests passed.");
