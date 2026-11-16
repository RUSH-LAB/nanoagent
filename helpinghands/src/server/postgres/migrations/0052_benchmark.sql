-- Uploaded harness benchmarks (routes/benchmark.js, routes/benchmark-worker.js;
-- docs/contracts/rush-benchmark-api.md in the NanoAgent project).
--
-- A benchmark is published by any member and readable by every signed-in member; the case set under it too,
-- except its private references, which only the worker API reads. Runs belong to
-- the member who submitted them, in the workspace they submitted them from: a run
-- and what hangs off it are visible to that member while they are still a member
-- of that workspace, and to nobody else. The worker API acts as `benchmark_system`:
-- it has no member, only its bearer token, so it sets app.benchmark_system the way
-- the lab upload does (0034).
create or replace function request_benchmark_system() returns boolean language sql stable as $$
  select coalesce(current_setting('app.benchmark_system', true) = 'on', false)
$$;

-- ── Case sets ──
-- A case set is made by publishing a benchmark and is identified by its digest, so identical ones are shared.
-- `task`, each case's `arguments` and the private references are `json`, not `jsonb`: the prompt a harness gets prints
-- them in the order the publisher gave their keys and with its numbers as it wrote them (`1.0`, `1e-05`), which jsonb
-- does not keep.
create table benchmark_case_set (
  case_set_id text primary key,
  publisher_id text not null references app_user(id) on delete cascade,
  plugin_id text not null,
  plugin_name text not null,
  version text not null,
  package_sha256 text not null check (package_sha256 ~ '^[0-9a-f]{64}$'),
  task_id text not null,
  task json not null,
  context text not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  published_at timestamptz not null default now(),
  foreign key (plugin_id, version) references market_plugin_version(plugin_id, version) on delete cascade
);
create index benchmark_case_set_package_idx on benchmark_case_set(package_sha256);

create table benchmark_case_set_case (
  case_set_id text not null references benchmark_case_set(case_set_id) on delete cascade,
  case_id text not null,
  position integer not null check (position >= 0),
  kind text not null check (kind in ('answer', 'refuse')),
  arguments json not null,
  expected_error text,
  reference_sha256 text not null check (reference_sha256 ~ '^[0-9a-f]{64}$'),
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  primary key (case_set_id, case_id),
  check ((kind = 'refuse') = (expected_error is not null))
);

-- What the plugin's verifier compares an attempt with: the pinned output (or JSON null, for a task the
-- verifier judges without one) of an answer case, the pinned error of a refusal case. No policy lets a member read it.
create table benchmark_case_set_private (
  case_set_id text not null references benchmark_case_set(case_set_id) on delete cascade,
  case_id text not null,
  reference json not null,
  primary key (case_set_id, case_id)
);

create function benchmark_case_set_owned(p_case_set_id text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.benchmark_case_set s where s.case_set_id = p_case_set_id and s.publisher_id = public.request_user_id())
$$;

alter table benchmark_case_set enable row level security;
create policy benchmark_case_set_read on benchmark_case_set for select using (request_user_id() is not null or request_benchmark_system());
create policy benchmark_case_set_insert on benchmark_case_set for insert with check (publisher_id = request_user_id());
alter table benchmark_case_set force row level security;

alter table benchmark_case_set_case enable row level security;
create policy benchmark_case_set_case_read on benchmark_case_set_case for select using (request_user_id() is not null or request_benchmark_system());
create policy benchmark_case_set_case_insert on benchmark_case_set_case for insert with check (benchmark_case_set_owned(case_set_id));
alter table benchmark_case_set_case force row level security;

alter table benchmark_case_set_private enable row level security;
create policy benchmark_case_set_private_read on benchmark_case_set_private for select using (request_benchmark_system());
create policy benchmark_case_set_private_insert on benchmark_case_set_private for insert with check (benchmark_case_set_owned(case_set_id));
alter table benchmark_case_set_private force row level security;

-- A benchmark: a case set and the run configuration pinned with it, for one plugin version, immutable once published.
-- A run takes everything but its policy and its harness from it.
create table benchmark (
  benchmark_id uuid primary key,
  name text not null check (name ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  plugin_id text not null,
  plugin_version text not null,
  case_set_id text not null references benchmark_case_set(case_set_id),
  model text not null,
  endpoint_label text not null,
  limits jsonb not null,
  coding_template text not null,
  task_instructions text not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  publisher_id text not null references app_user(id) on delete cascade,
  published_at timestamptz not null default now(),
  unique (plugin_id, plugin_version, name),
  foreign key (plugin_id, plugin_version) references market_plugin_version(plugin_id, version) on delete cascade
);
alter table benchmark enable row level security;
create policy benchmark_read on benchmark for select using (request_user_id() is not null or request_benchmark_system());
create policy benchmark_insert on benchmark for insert with check (publisher_id = request_user_id());
alter table benchmark force row level security;

-- The first upload of a member's harness `name@version` pins its source digest: another ZIP under that version is refused.
create table benchmark_harness_version (
  owner_id text not null references app_user(id) on delete cascade,
  name text not null,
  version text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (owner_id, name, version)
);
alter table benchmark_harness_version enable row level security;
create policy benchmark_harness_version_read on benchmark_harness_version for select using (owner_id = request_user_id() or request_benchmark_system());
create policy benchmark_harness_version_insert on benchmark_harness_version for insert with check (owner_id = request_user_id());
alter table benchmark_harness_version force row level security;

-- What each endpoint label's workers last said they can do (the maximum of each numeric limit, and whether they
-- give a harness internet access, and the `models` it prices): a preview, publication or run is checked against it, and a
-- worker is handed only runs within its own limits.
create table benchmark_worker_capability (
  endpoint_label text primary key,
  worker_id text not null,
  capabilities jsonb not null,
  updated_at timestamptz not null default now()
);
alter table benchmark_worker_capability enable row level security;
create policy benchmark_worker_capability_read on benchmark_worker_capability for select using (request_user_id() is not null or request_benchmark_system());
create policy benchmark_worker_capability_write on benchmark_worker_capability for all using (request_benchmark_system()) with check (request_benchmark_system());
alter table benchmark_worker_capability force row level security;

-- ── Content-addressed bytes ──
-- A package outlives its plugin's marketplace listing, so a retained run can be rerun after an uninstall.
create table benchmark_package (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  data bytea not null,
  check (encode(sha256(data), 'hex') = sha256)
);
alter table benchmark_package enable row level security;
create policy benchmark_package_read on benchmark_package for select using (request_benchmark_system());
create policy benchmark_package_insert on benchmark_package for insert with check (request_user_id() is not null or request_benchmark_system());
alter table benchmark_package force row level security;

create table benchmark_source (
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text not null references app_user(id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size integer not null check (size > 0),
  data bytea not null,
  -- What the ZIP's harness.yaml declares.
  harness_name text not null,
  harness_version text not null,
  dialects jsonb not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id, sha256),
  check (encode(sha256(data), 'hex') = sha256)
);
alter table benchmark_source enable row level security;
create policy benchmark_source_read on benchmark_source for select using (
  (user_id = request_user_id() and workspace_id = request_workspace_id() and is_workspace_member(workspace_id)) or request_benchmark_system()
);
create policy benchmark_source_insert on benchmark_source for insert with check (
  user_id = request_user_id() and workspace_id = request_workspace_id() and is_workspace_member(workspace_id)
);
alter table benchmark_source force row level security;

-- ── Previews and runs ──
-- A preview keeps what it resolved (`plan`) and its digest; a run is submitted against a preview only while
-- resolving the same request again gives the same digest.
create table benchmark_preview (
  preview_id uuid primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text not null references app_user(id) on delete cascade,
  plan jsonb not null,
  plan_digest text not null,
  created_at timestamptz not null default now()
);
alter table benchmark_preview enable row level security;
create policy benchmark_preview_read on benchmark_preview for select using (
  (user_id = request_user_id() and workspace_id = request_workspace_id() and is_workspace_member(workspace_id)) or request_benchmark_system()
);
create policy benchmark_preview_insert on benchmark_preview for insert with check (
  user_id = request_user_id() and workspace_id = request_workspace_id() and is_workspace_member(workspace_id)
);
alter table benchmark_preview force row level security;

-- A run pins the benchmark it was made from (its id and name), the case set (its id and digest, and the task and context
-- as published), the resolved selection, the policy, the prompt text, the effective limits, the model, endpoint, the
-- harness (name and version) and its dialects, and the source.
create table benchmark_run (
  run_id uuid primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text not null references app_user(id) on delete cascade,
  idempotency_key text not null,
  request_digest text not null,
  preview_id uuid not null,
  source_sha256 text not null,
  model text not null,
  endpoint_label text not null,
  dialects jsonb not null,
  policy text not null check (policy in ('coding', 'task_tools')),
  prompt_text text not null,
  limits jsonb not null,
  selection jsonb not null,
  renderer_version text not null,
  benchmark_id uuid not null,
  benchmark_name text not null,
  harness_name text not null,
  harness_version text not null,
  case_set_id text not null,
  case_set_digest text not null,
  publisher jsonb not null,
  plugin_id text not null,
  plugin_name text not null,
  version text not null,
  package_sha256 text not null references benchmark_package(sha256),
  task_id text not null,
  task json not null,
  context text not null,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id, idempotency_key),
  foreign key (workspace_id, user_id, source_sha256) references benchmark_source(workspace_id, user_id, sha256)
);
create index benchmark_run_member_idx on benchmark_run(workspace_id, user_id, created_at desc);
create index benchmark_run_benchmark_idx on benchmark_run(benchmark_id, created_at desc);

-- A selected case, with the prompt rendered for it ({system, user}; either may be null) and that prompt's digest.
create table benchmark_run_case (
  run_id uuid not null references benchmark_run(run_id) on delete cascade,
  case_id text not null,
  position integer not null,
  kind text not null check (kind in ('answer', 'refuse')),
  arguments json not null,
  expected_error text,
  content_digest text not null,
  prompt_system text,
  prompt_user text,
  prompt_sha256 text not null,
  primary key (run_id, case_id),
  check (prompt_system is not null or prompt_user is not null)
);

-- The case set's private reference as the run pinned it.
create table benchmark_run_private (
  run_id uuid not null,
  case_id text not null,
  reference json not null,
  primary key (run_id, case_id),
  foreign key (run_id, case_id) references benchmark_run_case(run_id, case_id) on delete cascade
);

create table benchmark_attempt (
  attempt_id uuid primary key,
  run_id uuid not null,
  case_id text not null,
  attempt_no integer not null check (attempt_no >= 1),
  rerun_of uuid references benchmark_attempt(attempt_id),
  state text not null default 'queued' check (state in ('queued', 'leased', 'final')),
  execution_status text check (execution_status in
    ('answered', 'refused', 'execution_failed', 'build_failed', 'canceled', 'interrupted')),
  execution_reason text,
  verdict text check (verdict in ('pass', 'fail')),
  explanation text check (explanation in ('invalid_answer', 'refused_answer_case', 'answered_refusal_case', 'execution_failed')),
  verifier_error text,
  coverage jsonb,
  metrics jsonb,
  fence integer not null default 0,
  worker_id text,
  lease_expires_at timestamptz,
  claimed_at timestamptz,
  finalized_at timestamptz,
  cancel_requested boolean not null default false,
  sealed boolean not null default false,
  next_cursor bigint not null default 1,
  final_cursor bigint,
  finalize_digest text,
  created_at timestamptz not null default now(),
  unique (run_id, case_id, attempt_no),
  foreign key (run_id, case_id) references benchmark_run_case(run_id, case_id) on delete cascade,
  check (verdict is null or verifier_error is null),
  check (explanation is null or verdict = 'fail'),
  check (state <> 'final' or execution_status is not null)
);
create index benchmark_attempt_claim_idx on benchmark_attempt(state, created_at);
create index benchmark_attempt_run_idx on benchmark_attempt(run_id);

-- ── Evidence ──
create table benchmark_event (
  attempt_id uuid not null references benchmark_attempt(attempt_id) on delete cascade,
  cursor bigint not null check (cursor >= 1),
  event_id text not null,
  source text not null,
  kind text not null,
  sequence bigint not null,
  occurred_ns bigint,
  data jsonb not null,
  payload_sha256s text[] not null default '{}',
  digest text not null,
  received_at timestamptz not null default now(),
  primary key (attempt_id, cursor),
  unique (attempt_id, event_id)
);

create table benchmark_span (
  attempt_id uuid not null references benchmark_attempt(attempt_id) on delete cascade,
  span_id text not null,
  kind text not null,
  name text not null,
  parent_id text,
  scope text,
  status text,
  start_ns bigint,
  end_ns bigint,
  provenance text,
  target text,
  attributes jsonb not null default '{}',
  primary key (attempt_id, span_id)
);

create table benchmark_link (
  attempt_id uuid not null references benchmark_attempt(attempt_id) on delete cascade,
  kind text not null,
  from_id text not null,
  to_id text not null,
  method text,
  attributes jsonb not null default '{}',
  primary key (attempt_id, kind, from_id, to_id)
);

create table benchmark_payload (
  attempt_id uuid not null references benchmark_attempt(attempt_id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size integer not null check (size >= 0),
  redaction text not null check (redaction in ('none', 'redacted', 'truncated')),
  content_type text not null,
  data bytea not null,
  primary key (attempt_id, sha256),
  check (encode(sha256(data), 'hex') = sha256)
);

-- ── Spend ──
create table benchmark_admission (
  attempt_id uuid not null references benchmark_attempt(attempt_id) on delete cascade,
  call_id text not null,
  reserve_usd numeric(20, 8) not null check (reserve_usd >= 0),
  status text not null check (status in ('reserved', 'uncertain', 'settled')),
  cost_usd numeric(20, 8),
  provenance jsonb,
  day date not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  deadline_at timestamptz not null,
  primary key (attempt_id, call_id),
  check ((status = 'settled') = (cost_usd is not null))
);

create table benchmark_accounting (
  attempt_id uuid not null references benchmark_attempt(attempt_id) on delete cascade,
  call_id text not null,
  version integer not null check (version >= 1),
  record jsonb not null,
  created_at timestamptz not null default now(),
  primary key (attempt_id, call_id, version)
);

-- What the members and workspaces have committed on a UTC day, reserved or settled.
create table benchmark_budget (
  scope_kind text not null check (scope_kind in ('member', 'workspace')),
  scope_id text not null,
  day date not null,
  committed_usd numeric(20, 8) not null default 0,
  primary key (scope_kind, scope_id, day)
);

-- Row-level security. A run and its parts are the submitting member's, as
-- long as they are in the workspace; only the worker API writes them.
alter table benchmark_run enable row level security;
create policy benchmark_run_read on benchmark_run for select using (
  (user_id = request_user_id() and workspace_id = request_workspace_id() and is_workspace_member(workspace_id)) or request_benchmark_system()
);
create policy benchmark_run_write on benchmark_run for all using (request_benchmark_system()) with check (request_benchmark_system());
alter table benchmark_run force row level security;

do $$
declare t text;
begin
  foreach t in array array['benchmark_run_case', 'benchmark_attempt'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (exists (select 1 from benchmark_run r where r.run_id = %I.run_id))', t || '_read', t, t);
    execute format('create policy %I on %I for all using (request_benchmark_system()) with check (request_benchmark_system())', t || '_write', t);
    execute format('alter table %I force row level security', t);
  end loop;
  foreach t in array array['benchmark_event', 'benchmark_span', 'benchmark_link', 'benchmark_payload', 'benchmark_admission', 'benchmark_accounting'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (exists (select 1 from benchmark_attempt a where a.attempt_id = %I.attempt_id))', t || '_read', t, t);
    execute format('create policy %I on %I for all using (request_benchmark_system()) with check (request_benchmark_system())', t || '_write', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- No policy lets a member read these.
alter table benchmark_run_private enable row level security;
create policy benchmark_run_private_system on benchmark_run_private for all using (request_benchmark_system()) with check (request_benchmark_system());
alter table benchmark_run_private force row level security;

alter table benchmark_budget enable row level security;
create policy benchmark_budget_system on benchmark_budget for all using (request_benchmark_system()) with check (request_benchmark_system());
alter table benchmark_budget force row level security;


-- A run as its summary lists it: public columns only (no evidence, no source sha256, no workspace). An attempt gives its state,
-- verdict and metrics, and whether a verifier error ended it, never its text. The view reads as the caller (security_invoker), so
-- a member sees their own runs, as the run's policies decide.
create view benchmark_run_summary with (security_invoker = true) as
select r.run_id, r.benchmark_id, r.harness_name, r.harness_version, r.benchmark_name, r.plugin_id, r.plugin_name, r.version as plugin_version,
  r.model, r.policy, r.user_id, u.display_name as user_name, u.github_login as user_github, r.canceled_at, r.created_at,
  (select coalesce(array_agg(c.case_id order by c.position), '{}') from benchmark_run_case c where c.run_id = r.run_id) as case_ids,
  (select coalesce(jsonb_agg(jsonb_build_object('case_id', a.case_id, 'attempt_no', a.attempt_no, 'state', a.state, 'verdict', a.verdict,
      'verifier_error', a.verifier_error is not null, 'metrics', a.metrics)), '[]'::jsonb) from benchmark_attempt a where a.run_id = r.run_id) as attempts
  from benchmark_run r join app_user u on u.id = r.user_id;

-- What other members may see of a benchmark's runs. benchmark_run is the owner's alone, so these run as the system for
-- their one query (the function's own `set`, which ends with it) and return the summary columns only.
create function benchmark_stats(p_benchmark_id uuid)
returns table (run_count bigint, runner_count bigint)
language sql stable security definer set search_path = pg_catalog, public set app.benchmark_system = 'on' as $$
  select count(*), count(distinct r.user_id) from public.benchmark_run r where r.benchmark_id = p_benchmark_id
$$;

create function benchmark_results(p_benchmark_id uuid, p_limit integer, p_before timestamptz)
returns setof benchmark_run_summary
language sql stable security definer set search_path = pg_catalog, public set app.benchmark_system = 'on' as $$
  select * from public.benchmark_run_summary s
   where s.benchmark_id = p_benchmark_id and (p_before is null or s.created_at < p_before)
   order by s.created_at desc, s.run_id limit p_limit
$$;
