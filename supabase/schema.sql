-- Control Point — Supabase schema for cross-device run history sync.
--
-- Run this once, in full, in your Supabase project's SQL Editor
-- (left sidebar -> SQL Editor -> New query -> paste this -> Run).
--
-- Mirrors the shape of a run as already stored locally in IndexedDB, so syncing
-- is a straight copy — no data transformation needed on either side.

create table if not exists public.runs (
  id text primary key,                                 -- matches the local run id, e.g. "run_<timestamp>"
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null,                                   -- 'explore' | 'timeTrial' | 'scoreAttack'
  started_at bigint not null,                            -- ms since epoch
  ended_at bigint,
  total_ms bigint not null,
  distance_m integer not null,
  elevation_gain_m integer,
  elevation_loss_m integer,
  points_total integer not null,
  points_collected integer not null,
  score integer not null,
  settings jsonb not null,                                -- the run's settings object, as-is
  points jsonb not null,                                  -- the points array, as-is
  route jsonb not null,                                   -- the [{lat,lon,t,alt}] route, as-is
  loop_geometry jsonb,                                    -- suggested loop path, if any
  created_at timestamptz not null default now()
);

create index if not exists runs_user_id_started_at_idx
  on public.runs (user_id, started_at desc);

-- Row Level Security: every user can only ever see/change their own runs.
-- Without this, anyone with the publishable key could read/write ALL rows.
alter table public.runs enable row level security;

create policy "Users can view their own runs"
  on public.runs for select
  using (auth.uid() = user_id);

create policy "Users can insert their own runs"
  on public.runs for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own runs"
  on public.runs for update
  using (auth.uid() = user_id);

create policy "Users can delete their own runs"
  on public.runs for delete
  using (auth.uid() = user_id);
