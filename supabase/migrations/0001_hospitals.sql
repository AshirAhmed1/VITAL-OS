-- VITAL OS — Milestone 2, step 1: hospitals
--
-- The tenancy root. Both `clinicians.hospital_id` (step 2) and
-- `patients.hospital_id` (step 5) reference this table.
--
-- RLS stays OFF for all of M2. With RLS off, the grants at the bottom of this
-- file are the only access control on the table; M3 adds policies on top of
-- them. Enabling RLS here without policies would make reads silently return
-- zero rows -- decline the Supabase linter if it offers to do that for you.
--
-- Idempotent throughout. Re-running this in the SQL Editor is safe.

create table if not exists public.hospitals (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

comment on table public.hospitals is
  'Tenancy root. One row per hospital; clinicians and patients both scope to it.';
comment on column public.hospitals.id is
  'Stable slug, not a uuid. Mirrors DEMO_HOSPITAL_ID in lib/auth.ts and the default on patients.hospital_id.';

-- Demo tenant.
--
-- Both literals below are duplicated in lib/auth.ts as DEMO_HOSPITAL_ID and
-- DEMO_HOSPITAL_NAME. If either changes, both places change together --
-- step 5 defaults patients.hospital_id to this exact id, so a mismatch shows
-- up as a foreign key violation on the next admit, not at migration time.
insert into public.hospitals (id, name)
values ('vital-demo-hospital', 'VITAL Demo Hospital')
on conflict (id) do nothing;

-- Explicit rather than implied. New tables default to RLS off, but stating it
-- keeps the M2 posture legible to anyone reading the migration in isolation.
alter table public.hospitals disable row level security;

-- Read-only to the app. Hospitals are administrative records: the application
-- resolves a tenant, it never creates one.
--
-- REVOKE FIRST. Supabase configures `alter default privileges in schema public
-- grant all on tables to anon, authenticated, service_role`, so this table
-- arrives with full DML already attached -- a bare `grant select` is additive
-- and leaves anon able to delete hospital rows. Confirmed against
-- information_schema.role_table_grants after the first run of this file, which
-- returned all seven privileges for both anon and authenticated.
--
-- postgres (owner) and service_role (server-side escape hatch) are left alone
-- deliberately; the backfill in step 3 and the trigger in step 4 need write
-- access that does not come from the app's anon/authenticated roles.
revoke all on table public.hospitals from anon, authenticated;

grant select on table public.hospitals to anon;
grant select on table public.hospitals to authenticated;
