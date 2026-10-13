-- A member's own provider API keys, kept by Mochi (postgres/member-keys.js): their
-- runs use them on the hosted NanoAgent whenever Mochi Lab is not connected. Each
-- value is AES-256-GCM ciphertext; only its hint (how it begins and ends) is plain.
create table member_api_key (
  user_id text not null references app_user(id) on delete cascade,
  env text not null check (env ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  ciphertext text not null,
  hint text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, env)
);

alter table member_api_key enable row level security;
create policy member_api_key_scope on member_api_key for all
  using (user_id = request_user_id()) with check (user_id = request_user_id());
alter table member_api_key force row level security;
