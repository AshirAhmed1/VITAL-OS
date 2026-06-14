-- Optional additive migration for voice-controlled chart updates.
-- Safe to run on existing VITAL OS demo databases.

alter table public.patients
  add column if not exists chart_notes jsonb not null default '[]'::jsonb,
  add column if not exists discharged_at timestamptz,
  add column if not exists discharge_reason text,
  add column if not exists discharged_by text;

comment on column public.patients.chart_notes is
  'Chart notes: [{ text, timestamp, provider }]';
comment on column public.patients.discharged_at is
  'When set, patient is removed from active roster and listed as discharged.';
