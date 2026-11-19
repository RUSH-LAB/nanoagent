-- A plugin page's Leaderboard tab ranks the harnesses run on one task of a plugin, from every member's scored attempts: each run case's
-- newest attempt once it is final with a verdict (a free-form Terminal session has none), its time (metrics' elapsed_ms) and what its
-- model calls cost (null while one is unsettled, as GET attempts/{id}/accounting totals them). benchmark_run is the owner's alone, so this
-- runs as the system for its one query, as benchmark_results does, and returns no evidence: the route shows each run's trace to its owner only.
create function benchmark_leaderboard(p_plugin_id text, p_task_id text)
returns table (run_id uuid, attempt_id uuid, user_id text, user_name text, user_github text, harness_name text, verdict text,
  elapsed_ms double precision, cost_usd double precision, created_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare prior text := coalesce(current_setting('app.benchmark_system', true), 'off');
begin
  perform set_config('app.benchmark_system', 'on', true);
  return query
  select r.run_id, a.attempt_id, r.user_id, u.display_name, u.github_login, r.harness_name, a.verdict, (a.metrics->>'elapsed_ms')::float8,
    (select case when bool_or(d.status <> 'settled') then null else coalesce(sum(d.cost_usd), 0)::float8 end
       from public.benchmark_admission d where d.attempt_id = a.attempt_id),
    r.created_at
    from public.benchmark_run r join public.app_user u on u.id = r.user_id
    cross join lateral (select distinct on (x.case_id) x.* from public.benchmark_attempt x
      where x.run_id = r.run_id and x.case_id is not null order by x.case_id, x.attempt_no desc) a
   where r.plugin_id = p_plugin_id and r.task_id = p_task_id and a.state = 'final' and a.verdict is not null
   order by r.created_at desc, r.run_id;
  perform set_config('app.benchmark_system', prior, true);
end
$$;
create index benchmark_run_plugin_task_idx on benchmark_run(plugin_id, task_id);
