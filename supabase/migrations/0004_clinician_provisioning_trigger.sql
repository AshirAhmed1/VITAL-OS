-- VITAL OS — Milestone 2, step 4: clinician provisioning trigger
--
-- Keeps public.clinicians in sync with auth.users automatically, so new
-- accounts no longer need the ad hoc SQL that provisioned the first three.
--
-- Depends on 0003_backfill_clinicians.sql.
-- Idempotent: CREATE OR REPLACE plus DROP TRIGGER IF EXISTS.

-- ---------------------------------------------------------------------------
-- The function
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER: runs as the owner (postgres), not the caller. Required --
-- inserts into auth.users originate from supabase_auth_admin, which has no
-- grant on public.clinicians, and deliberately is not getting one.
--
-- SET search_path = '': Supabase's recommended hardening for SECURITY DEFINER
-- functions. It closes the search_path hijack where a caller-controlled schema
-- shadows an unqualified table name. Every identifier below is therefore
-- schema-qualified; an unqualified reference will fail at runtime, not at
-- creation time.

create or replace function public.handle_clinician_provisioning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.clinicians (id, role, full_name, staff_ref)
  values (
    new.id,

    -- SAME POLICY AS THE 0003 BACKFILL. Absent or out-of-constraint role
    -- lands on 'staff' -- the restricted role, blocked from every clinical
    -- field by isRestrictedClinicalPatch in lib/auth.ts.
    --
    -- Safe only because signups are disabled on this instance (verified: POST
    -- /auth/v1/signup returns 422 signup_disabled). Re-enabling open signup
    -- makes this a self-service path to a staff account, which can read the
    -- roster through the API once step 6 sources role from this table.
    case
      when new.raw_user_meta_data->>'role' in ('doctor', 'staff')
        then new.raw_user_meta_data->>'role'
      else 'staff'
    end,

    new.raw_user_meta_data->>'full_name',

    coalesce(
      new.raw_user_meta_data->>'doctor_id',
      new.raw_user_meta_data->>'staff_id'
    )
  )
  -- Serves the UPDATE trigger below. The dashboard's "Add user" creates an
  -- account with empty metadata, and role arrives in a later UPDATE -- without
  -- this, that clinician would stay 'staff' forever while metadata said
  -- otherwise, and step 6 reads this table.
  --
  -- hospital_id is deliberately NOT in the update list. Tenancy is not
  -- reassignable through auth metadata.
  on conflict (id) do update
    set role      = excluded.role,
        full_name = excluded.full_name,
        staff_ref = excluded.staff_ref;

  return new;

exception
  when others then
    -- NEVER BLOCK THE AUTH WRITE. An exception propagating out of a trigger on
    -- auth.users aborts the whole transaction: user creation fails with an
    -- opaque 500 and nothing points at this function. Fail open on the auth
    -- write, fail closed on authorization -- a user with no clinicians row is
    -- denied everywhere by step 6, which is the safe direction.
    --
    -- The realistic failure is a staff_ref unique violation from duplicated
    -- metadata. RAISE WARNING surfaces it in Supabase → Logs → Postgres, so
    -- this is recoverable, not silent. Re-running 0003 repairs the row.
    raise warning 'VITAL-OS: clinician provisioning failed for auth user %: %',
      new.id, sqlerrm;
    return new;
end;
$$;

comment on function public.handle_clinician_provisioning() is
  'Mirrors auth.users metadata into public.clinicians on insert and on metadata change. Never raises: failures are logged as warnings so auth writes always succeed.';

-- ---------------------------------------------------------------------------
-- The triggers
-- ---------------------------------------------------------------------------

-- AFTER, not BEFORE: clinicians.id has a foreign key to auth.users(id), so the
-- auth row must exist before the insert is attempted.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_clinician_provisioning();

-- The WHEN clause is load-bearing. auth.users is updated on every sign-in
-- (last_sign_in_at) and on token refresh; without the guard this function
-- would run on all of them.
drop trigger if exists on_auth_user_metadata_changed on auth.users;
create trigger on_auth_user_metadata_changed
  after update on auth.users
  for each row
  when (old.raw_user_meta_data is distinct from new.raw_user_meta_data)
  execute function public.handle_clinician_provisioning();
