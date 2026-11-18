-- A member's benchmark worker runs on the member's own computer and acts only for that member. The member mints a
-- credential for it: a random token whose SHA-256 is all that is kept, revocable, good only on /api/benchmark-worker/.
create table benchmark_worker_credential (
  credential_id uuid primary key,
  user_id text not null references app_user(id) on delete cascade,
  name text not null,
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index benchmark_worker_credential_user_idx on benchmark_worker_credential(user_id, created_at desc);
alter table benchmark_worker_credential enable row level security;
create policy benchmark_worker_credential_scope on benchmark_worker_credential for all
  using (user_id = request_user_id() or request_benchmark_system())
  with check (user_id = request_user_id() or request_benchmark_system());
alter table benchmark_worker_credential force row level security;

-- What a worker advertises is now per member and endpoint label. Capabilities advertised by the shared deployment worker
-- belong to no member, so they are dropped; a member's own worker advertises again at its next claim.
-- The delete runs with FORCE RLS lifted: its only write policy needs app.benchmark_system, which a migration does not set.
alter table benchmark_worker_capability no force row level security;
delete from benchmark_worker_capability;
alter table benchmark_worker_capability force row level security;
alter table benchmark_worker_capability drop constraint benchmark_worker_capability_pkey;
alter table benchmark_worker_capability add column user_id text not null references app_user(id) on delete cascade;
alter table benchmark_worker_capability add primary key (user_id, endpoint_label);
drop policy benchmark_worker_capability_read on benchmark_worker_capability;
create policy benchmark_worker_capability_read on benchmark_worker_capability for select using (user_id = request_user_id() or request_benchmark_system());

-- A claim scans the member's own open runs of an endpoint label, oldest first.
drop index benchmark_run_claim_idx;
create index benchmark_run_claim_idx on benchmark_run(user_id, endpoint_label, created_at, run_id) where canceled_at is null;
