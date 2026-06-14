/**
 * Voice command parser tests — run with: npx tsx lib/patient-command-parser.spec.ts
 */

import assert from "node:assert/strict";

import { parsePatientCommand } from "./patient-command-parser";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

test("move room command", () => {
  const r = parsePatientCommand("Move Vithu Patel to room 20");
  assert.equal(r.intent, "moveRoom");
  assert.equal(r.patientHint, "Vithu Patel");
  assert.match(r.room ?? "", /20/);
});

test("add medication command", () => {
  const r = parsePatientCommand("Add Aspirin to Vithu Patel");
  assert.equal(r.intent, "addMedication");
  assert.equal(r.medication, "Aspirin");
  assert.equal(r.patientHint, "Vithu Patel");
});

test("symptom status command", () => {
  const r = parsePatientCommand("Mark chest pain improving");
  assert.equal(r.intent, "updateSymptomStatus");
  assert.equal(r.symptom, "chest pain");
  assert.equal(r.symptomStatus, "Improving");
});

test("discharge command", () => {
  const r = parsePatientCommand("Discharge Vithu Patel");
  assert.equal(r.intent, "dischargePatient");
  assert.equal(r.patientHint, "Vithu Patel");
});

test("undo command", () => {
  const r = parsePatientCommand("Undo last change");
  assert.equal(r.intent, "undo");
});

test("patient summary command", () => {
  const r = parsePatientCommand("Summarize Vithu Patel");
  assert.equal(r.intent, "patientSummary");
});

console.log("\nAll patient command parser tests passed.");
