-- A benchmark case is a Terminal session (verified-benchmark.md in the repository root): it holds the exact prompt every harness gets, a typed
-- input (`arguments`) that stays out of the VM, optional fixtures (a gzipped tar kept once per digest) and, for a refusal case, its expected
-- error. The coding and task-tools policies, the prompt template and task instructions, the case set's context, the previews and the uploaded
-- harness sources are gone: a harness is an agent of the shell harness (`claude`, `codex`, `pi`, `dsh`, `hermes`, `nanoagent`) or `rush <command>`.
--
-- No backward compatibility: the benchmarks, case sets and runs of the old shape are deleted, with no data migration. The free-form Terminal
-- sessions (runs of no task) are kept.
alter table benchmark no force row level security;
alter table benchmark_case_set no force row level security;
alter table benchmark_run no force row level security;

delete from benchmark_run where task_id is not null;
delete from benchmark;
delete from benchmark_case_set;

-- What reads the columns that go.
drop function benchmark_results(uuid, integer, timestamptz);
drop view benchmark_run_summary;
drop function benchmark_leaderboard(text);
-- Runs are a member's own: no count of other members' runs either.
drop function benchmark_stats(uuid);

-- ── Case sets and benchmarks ──
alter table benchmark_case_set drop column context;
alter table benchmark_case_set_case
  add column prompt text not null,
  add column prompt_sha256 text not null check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  add column fixtures_sha256 text check (fixtures_sha256 ~ '^[0-9a-f]{64}$'),
  add column fixtures_files jsonb,
  add check ((fixtures_sha256 is null) = (fixtures_files is null));
alter table benchmark drop column coding_template, drop column task_instructions;

-- A case's fixtures archive (the gzipped tar, at most 8 MiB), kept once per digest whichever cases hold it. The worker API reads it; its first
-- publisher is charged its bytes against their storage.
create table benchmark_fixtures (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  publisher_id text references app_user(id) on delete set null,
  archive bytea not null check (octet_length(archive) > 0),
  check (encode(sha256(archive), 'hex') = sha256)
);
alter table benchmark_fixtures enable row level security;
create policy benchmark_fixtures_read on benchmark_fixtures for select using (publisher_id = request_user_id() or request_benchmark_system());
create policy benchmark_fixtures_insert on benchmark_fixtures for insert with check (publisher_id = request_user_id());
alter table benchmark_fixtures force row level security;

-- Whether an archive is kept already, whoever published it, which a member's own read of the table cannot tell.
create function benchmark_fixtures_known(p_sha256 text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.benchmark_fixtures f where f.sha256 = p_sha256)
$$;

-- ── Runs ──
-- A run names its harness (`harness_name`: an agent, or `rush <command>`, `shell` for a free-form Terminal session) and nothing else of it: no
-- source, version, dialects or policy, and no preview.
alter table benchmark_run
  drop column preview_id, drop column source_sha256, drop column dialects, drop column policy, drop column prompt_text,
  drop column renderer_version, drop column harness_version, drop column context;
drop table benchmark_preview;
drop table benchmark_source;
drop table benchmark_harness_version;

-- A selected case as the run pinned it: the case's prompt, fixtures' digest and files, arguments and expected error, from the case set.
alter table benchmark_run_case drop constraint benchmark_run_case_pinned;
alter table benchmark_run_case
  drop column prompt_system, drop column prompt_user, drop column pin_error,
  alter column arguments set not null, alter column content_digest set not null, alter column prompt_sha256 set not null,
  add column prompt text not null,
  add column fixtures_sha256 text check (fixtures_sha256 ~ '^[0-9a-f]{64}$'),
  add column fixtures_files jsonb,
  add check ((fixtures_sha256 is null) = (fixtures_files is null));

-- ── Attempts ──
-- The verdict keeps the verifier's named checks, `[{name, status}]` with status passed, failed or skipped, never their messages or values. They
-- are read with the attempt, so only by its run's member. A harness is no longer built, so no attempt is `build_failed`.
alter table benchmark_attempt add column checks jsonb;
alter table benchmark_attempt drop constraint benchmark_attempt_execution_status_check;
alter table benchmark_attempt add constraint benchmark_attempt_execution_status_check check (execution_status in
  ('answered', 'refused', 'execution_failed', 'canceled', 'interrupted', 'ended'));

-- ── What read the dropped columns ──
-- The run summary of 0052 and 0057, without the policy and the harness version. Runs are private to their member: there is no function that reads
-- another member's runs, so benchmark_results and benchmark_leaderboard are not made again.
create view benchmark_run_summary with (security_invoker = true) as
select r.run_id, r.benchmark_id, r.harness_name, r.benchmark_name, r.plugin_id, r.plugin_name, r.version as plugin_version,
  r.model, r.user_id, u.display_name as user_name, u.github_login as user_github, r.canceled_at, r.created_at,
  (select coalesce(array_agg(c.case_id order by c.position), '{}') from benchmark_run_case c where c.run_id = r.run_id) as case_ids,
  (select coalesce(jsonb_agg(jsonb_build_object('case_id', a.case_id, 'attempt_no', a.attempt_no, 'state', a.state, 'verdict', a.verdict,
      'verifier_error', a.verifier_error is not null, 'metrics', case when a.metrics is null then null else jsonb_strip_nulls(jsonb_build_object(
        'total_tokens', a.metrics->'total_tokens', 'input_tokens', a.metrics->'input_tokens', 'output_tokens', a.metrics->'output_tokens',
        'cache_read_tokens', a.metrics->'cache_read_tokens', 'cache_write_tokens', a.metrics->'cache_write_tokens', 'elapsed_ms', a.metrics->'elapsed_ms',
        'missing_calls', jsonb_build_object('total', a.metrics->'missing_calls'->'total', 'input', a.metrics->'missing_calls'->'input',
          'output', a.metrics->'missing_calls'->'output', 'cache_read', a.metrics->'missing_calls'->'cache_read',
          'cache_write', a.metrics->'missing_calls'->'cache_write'))) end)), '[]'::jsonb)
    from (select distinct on (x.case_id) x.* from benchmark_attempt x where x.run_id = r.run_id order by x.case_id, x.attempt_no desc) a) as attempts
  from benchmark_run r join app_user u on u.id = r.user_id;

alter table benchmark force row level security;
alter table benchmark_case_set force row level security;
alter table benchmark_run force row level security;
