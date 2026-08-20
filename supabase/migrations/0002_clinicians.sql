-- VITAL OS — Milestone 2, step 2: clinicians
--
-- One row per auth.users row. Becomes the authorization source in step 6,
-- replacing the client-supplied x-vital-role header.
--
-- RLS stays OFF for all of M2. The grants at the bottom are the only access
-- control here; M3 adds policies on top of them, after the cross-tenant
-- denial test.
--
-- Depends on 0001_hospitals.sql (hospital_id references it).
-- Idempotent throughout. Safe to re-run in the SQL Editor.

create table if not exists public.clinicians (
  -- Shares auth.users' primary key rather than carrying its own. Makes the
  -- one-row-per-user invariant structural instead of something the trigger in
  -- step 4 has to maintain, and makes step 6's lookup a primary key hit on the
  -- uuid already in the session.
  --
  -- ON DELETE CASCADE matters more than it looks: three auth users were
  -- deleted from the dashboard earlier in this milestone. Without the cascade
  -- that would have left orphaned clinician rows carrying live roles.
  id           uuid primary key
                 references auth.users (id) on delete cascade,

  -- Tenancy scope. The default lets a hand-written insert stay valid without
  -- restating the literal; the step-4 trigger sets it explicitly anyway.
  hospital_id  text not null default 'vital-demo-hospital'
                 references public.hospitals (id),

  -- No column default, deliberately. A manual insert that omits role should
  -- fail loudly rather than quietly land on one. The step-4 trigger supplies
  -- 'staff' when auth metadata carries no role -- that policy belongs in the
  -- trigger, where it is visible, not hidden in a column default.
  --
  -- Values match VitalRole in lib/auth.ts ("doctor" | "staff"). Adding a third
  -- value here without widening that union puts a role in the database that
  -- TypeScript cannot represent and isRestrictedClinicalPatch cannot classify.
  role         text not null check (role in ('doctor', 'staff')),

  full_name    text,

  -- One column, not two. Verified against live data: doctor_id and staff_id
  -- are mutually exclusive in raw_user_meta_data, and their only consumer
  -- (vital-os-client.tsx:5521-5525) tests for presence and then renders
  -- userName -- the value itself is never displayed or compared. Two nullable
  -- columns would permit a row holding both and force a coalesce on every
  -- read. Nullable because step 4 does not generate one for auto-provisioned
  -- users; unique because nulls do not conflict in Postgres, so the constraint
  -- costs nothing and catches double-assignment.
  staff_ref    text unique,

  created_at   timestamptz not null default now()
);

comment on table public.clinicians is
  'One row per auth.users row. Authorization source from M2 step 6 onward; auth user_metadata remains the write source that populates it.';
comment on column public.clinicians.role is
  'Mirrors VitalRole in lib/auth.ts. Widening this check requires widening that union.';
comment on column public.clinicians.staff_ref is
  'Formerly doctor_id / staff_id in user_metadata. Opaque label, not an identifier -- nothing reads the value.';

-- Supports the tenant predicate M3 policies will filter on, and step 3's
-- backfill verification. Not needed for step 6, which hits the primary key.
create index if not exists clinicians_hospital_id_idx
  on public.clinicians (hospital_id);

alter table public.clinicians disable row level security;

-- REVOKE FIRST. Both postgres and supabase_admin set ALTER DEFAULT PRIVILEGES
-- GRANT ALL on tables in schema public to anon, authenticated and service_role
-- (confirmed via pg_default_acl), so this table arrives with full DML already
-- attached and a bare GRANT would be additive.
--
-- This matters more here than on hospitals: role is what step 6 reads to
-- authorize clinical writes. Leaving the inherited UPDATE in place would let
-- any logged-in browser PATCH its own row to 'doctor' through PostgREST and
-- gain the clinical field access isRestrictedClinicalPatch exists to block.
revoke all on table public.clinicians from anon, authenticated;

-- SELECT only, and only to authenticated. Writes belong to the step-4 trigger,
-- which runs as SECURITY DEFINER and does not need a grant here. anon gets
-- nothing: an unauthenticated request has no clinician row to look up.
--
-- Known M2 gap, closed in M3: with RLS off, an authenticated user can read
-- every clinician row, not just their own -- names and roles across all
-- tenants. Read-only, so it is disclosure rather than escalation, and it is
-- exactly what the cross-tenant denial test is written to catch.
grant select on table public.clinicians to authenticated;
