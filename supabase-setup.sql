-- Run this once in Supabase: SQL editor -> New query -> paste -> Run
-- (Uses its own table, so it can live in the same Supabase project as LMJ without touching LMJ's data.)
create table if not exists public.jofus_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.jofus_store enable row level security;
