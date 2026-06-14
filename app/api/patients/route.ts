import { NextResponse } from "next/server";

import {
  DOCTOR_ONLY_API_MESSAGE,
  parseRoleFromRequest,
} from "@/lib/auth";
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
    const role = parseRoleFromRequest(req, body.role);
    if (role !== "doctor") {
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
    const message = e instanceof Error ? e.message : "Failed to create patient.";
    const status = /required/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
