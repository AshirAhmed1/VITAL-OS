-- VITAL OS — Milestone 2, step 5: tenancy columns on patients
--
-- Adds hospital_id (populated now, via default) and clinician_id (nullable,
-- populated in step 6 once routes can see the caller's identity).
--
-- Depends on 0002_clinicians.sql and 0001_hospitals.sql.
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

-- ---------------------------------------------------------------------------
-- hospital_id — tenancy scope
-- ---------------------------------------------------------------------------
--
-- NOT NULL with a default, so ADD COLUMN backfills every existing row in one
-- statement -- no separate backfill migration.
--
-- The default is load-bearing beyond the backfill. seedDemoPatientsIfEmpty()
-- (lib/patient-store.ts:44) runs on EVERY roster fetch, and the rows it builds
-- via demoPatientToRow() never mention hospital_id. Without the default, the
-- first roster load after this migration would fail a NOT NULL violation and
-- the app would show an empty roster.
--
-- Third and final place this literal appears, alongside 0001_hospitals.sql and
-- DEMO_HOSPITAL_ID in lib/auth.ts.
alter table public.patients
  add column if not exists hospital_id text not null
    default 'vital-demo-hospital'
    references public.hospitals (id);

-- ---------------------------------------------------------------------------
-- clinician_id — attribution
-- ---------------------------------------------------------------------------
--
-- Nullable and unpopulated until step 6. createPatientFromPayload(body:
-- unknown) (lib/patient-store.ts:182) has no access to the caller -- it
-- imports demo-patients, patient-db and supabase/server, nothing auth-related.
-- Step 6 threads the authenticated clinician's uuid down from the route.
--
-- ON DELETE SET NULL, not RESTRICT or CASCADE:
--
--   CASCADE  would delete patient records when a clinician is removed. Wrong
--            for clinical data under any circumstances.
--   RESTRICT would break auth user deletion outright. clinicians.id already
--            cascades from auth.users, so removing a user tries to delete the
--            clinician row; a RESTRICT here blocks that cascade and the
--            dashboard delete fails with no useful message.
--   SET NULL keeps the patient, drops the attribution. Chart notes retain
--            authorship separately.
alter table public.patients
  add column if not exists clinician_id uuid
    references public.clinicians (id) on delete set null;

comment on column public.patients.hospital_id is
  'Tenancy scope. M3 RLS policies filter on this. Default matches DEMO_HOSPITAL_ID in lib/auth.ts.';
comment on column public.patients.clinician_id is
  'Admitting clinician. Null until M2 step 6 threads caller identity into createPatientFromPayload.';

-- Supports the M3 policy predicate and the cross-tenant denial test.
create index if not exists patients_hospital_id_idx
  on public.patients (hospital_id);
create index if not exists patients_clinician_id_idx
  on public.patients (clinician_id);

-- ---------------------------------------------------------------------------
-- Grants: unchanged, deliberately
-- ---------------------------------------------------------------------------
--
-- public.patients holds table-level SELECT/INSERT/UPDATE/DELETE for anon and
-- authenticated (from supabase/patients.sql), and that stays -- the app's
-- routes run through the anon key and depend on it.
--
-- An earlier draft of this file tried to protect the two new columns with
--
--   revoke update (hospital_id, clinician_id) on public.patients from anon;
--
-- That statement succeeds and does nothing. A column-level REVOKE cannot
-- remove a table-level grant: in Postgres, UPDATE on a table implies UPDATE on
-- every column, including ones added afterwards. Verified via
-- information_schema.column_privileges, which still reported UPDATE on both
-- columns for both roles after the revoke ran.
--
-- Making it work would mean revoking table-level UPDATE and granting it back
-- column by column -- roughly 22 names, and every future ADD COLUMN would need
-- a matching grant or writes to it fail with "permission denied for column".
--
-- Not worth it here, because the exposure does not exist yet: RLS is off, so
-- anon can already read and write every row. Reassigning hospital_id is not an
-- escalation on a table that is fully open, and there is one tenant to move
-- between.
--
-- M3 OWNS THIS. An RLS policy with WITH CHECK (hospital_id = <caller's
-- hospital>) pins the column against reassignment without enumerating
-- anything, and covers columns added later for free. The cross-tenant denial
-- test should assert it directly:
--   PATCH /rest/v1/patients?id=eq.<other tenant's patient> must be refused.

-- Unchanged this milestone. M3 enables RLS on hospitals, clinicians and
-- patients together, after the cross-tenant denial test.
alter table public.patients disable row level security;
