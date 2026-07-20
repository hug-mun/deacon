create table if not exists public.mcp_oauth_codes (
  code_hash text primary key,
  client_id text not null,
  redirect_uri text not null,
  user_id uuid not null references public.users(id) on delete cascade,
  code_challenge text not null,
  resource text not null,
  scope text not null default 'knowledge:read',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mcp_oauth_codes_expires_idx
  on public.mcp_oauth_codes (expires_at);

alter table public.mcp_oauth_codes enable row level security;
