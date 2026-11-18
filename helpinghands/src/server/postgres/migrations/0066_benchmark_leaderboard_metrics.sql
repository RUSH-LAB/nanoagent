-- A plugin page's Leaderboard tab shows the profiler's figures of each run (its latency, model, tool and overhead time, tokens with the
-- cached share, and model and tool calls) and what each harness was given: the function returns each attempt's metrics as stored, in
-- place of its time and tokens, and the tools of the run's task, which RUSH's run was given beside submit.
drop function benchmark_leaderboard(text);
create function benchmark_leaderboard(p_plugin_id text)
returns table (run_id uuid, attempt_id uuid, user_id text, user_name text, user_github text, harness_name text, policy text, model text,
  case_id text, kind text, content_digest text, arguments json, prompt_system text, prompt_user text, tools json, reference json,
  verdict text, explanation text, execution_status text, execution_reason text, metrics jsonb, cost_usd double precision, created_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public set app.benchmark_system = 'on' as $$
  select r.run_id, a.attempt_id, r.user_id, u.display_name, u.github_login, r.harness_name, r.policy, r.model,
    c.case_id, c.kind, c.content_digest, c.arguments, c.prompt_system, c.prompt_user, r.task->'tools', p.reference,
    a.verdict, a.explanation, a.execution_status, a.execution_reason, a.metrics,
    (select case when bool_or(d.status <> 'settled') then null else coalesce(sum(d.cost_usd), 0)::float8 end
       from public.benchmark_admission d where d.attempt_id = a.attempt_id),
    r.created_at
    from public.benchmark_run r join public.app_user u on u.id = r.user_id
    cross join lateral (select distinct on (x.case_id) x.* from public.benchmark_attempt x
      where x.run_id = r.run_id and x.case_id is not null order by x.case_id, x.attempt_no desc) a
    join public.benchmark_run_case c on c.run_id = r.run_id and c.case_id = a.case_id
    left join public.benchmark_run_private p on p.run_id = r.run_id and p.case_id = a.case_id
   where r.plugin_id = p_plugin_id and r.harness_name <> 'shell' and a.state = 'final' and a.verdict is not null
     and c.content_digest is not null
   order by r.created_at desc, r.run_id
$$;
