-- The OpenRouter key Mochi made for a member (src/server/openrouter-keys.js): its
-- credit is Mochi's, and Mochi Lab holds it on their computer until they put a
-- key of their own there. Mochi keeps only its hash, OpenRouter's name for it,
-- never the key: a member's next one is made with what this one has left.
create table openrouter_grant (
  user_id text primary key references app_user(id) on delete cascade,
  hash text not null,
  created_at timestamptz not null default now()
);

alter table openrouter_grant enable row level security;
create policy openrouter_grant_owner on openrouter_grant for all
  using (user_id = request_user_id()) with check (user_id = request_user_id());
alter table openrouter_grant force row level security;
