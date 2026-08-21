import { NextResponse } from "next/server";

import { DOCTOR_ONLY_API_MESSAGE } from "@/lib/auth";
import { requireDoctor } from "@/lib/auth-server";
import {
  createPatientFromPayload,
  listDischargedPatients,
  listPatients,
} from "@/lib/patient-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const discharged = url.searchParams.get("discharged") === "true";
    const patients = discharged
      ? await listDischargedPatients()
      : await listPatients();
    return NextResponse.json(
      { patients },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to read roster.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    console.log("[PATIENT CREATE] Request body:", {
      name: body.name,
      age: body.age,
      sex: body.sex,
      room: body.room,
      chiefConcern: body.chiefConcern,
      medications: body.medications,
      allergies: body.allergies,
      triageAcuity: body.triageAcuity,
      lastVisit: body.lastVisit,
      keys: Object.keys(body),
    });
    const caller = await requireDoctor();
    if (!caller) {
      return NextResponse.json(
        { error: DOCTOR_ONLY_API_MESSAGE },
        { status: 403 }
      );
    }
    const { patient } = await createPatientFromPayload(body);
    return NextResponse.json(
      { patient },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const err = e as {
      message?: string;
      code?: string;
      details?: string;
      hint?: string;
      name?: string;
    } | null;
    const message =
      (err && typeof err.message === "string" && err.message) ||
      (e instanceof Error ? e.message : null) ||
      "Failed to create patient.";
    console.error("[PATIENT CREATE] Failure:", {
      message,
      code: err?.code,
      details: err?.details,
      hint: err?.hint,
      name: err?.name,
      typeof: typeof e,
      isError: e instanceof Error,
    });
    const status = /required/i.test(message) ? 400 : 500;
    return NextResponse.json(
      {
        error: message,
        code: err?.code,
        details: err?.details,
        hint: err?.hint,
      },
      { status }
    );
  }
}
