-- Run this once in Supabase: SQL editor -> New query -> paste -> Run
create table if not exists public.store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
-- Server-only access: the app uses the service key, which bypasses RLS.
alter table public.store enable row level security;
