create table if not exists public.service_health (
  service_name text primary key,
  status text not null default 'unknown' check (status in ('ok', 'degraded', 'down', 'unknown')),
  instance_id text,
  last_heartbeat_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.service_health enable row level security;

create policy "authenticated users can read service health"
  on public.service_health for select to authenticated
  using (true);

create index if not exists service_health_heartbeat_idx
  on public.service_health (last_heartbeat_at desc);
