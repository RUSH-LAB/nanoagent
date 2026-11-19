-- A plugin page's Leaderboard tab shows the runs by case, as examples/benchmark's report does: each scored attempt with its case (its id,
-- kind, content digest, arguments, the prompt its harness got and its private reference), its harness's policy and model, why it failed
-- and its tokens. Only attempts of a pinned case count, and none of the built-in Terminal (`shell`), whose sessions are free-form now
-- (those scored before it was are old test sessions). The route gives each run's case and reasons to its owner only.
drop function benchmark_leaderboard(text, text);
create function benchmark_leaderboard(p_plugin_id text, p_task_id text)
returns table (run_id uuid, attempt_id uuid, user_id text, user_name text, user_github text, harness_name text, policy text, model text,
  case_id text, kind text, content_digest text, arguments json, prompt_system text, prompt_user text, reference json,
  verdict text, explanation text, execution_status text, execution_reason text,
  elapsed_ms double precision, input_tokens bigint, output_tokens bigint, cost_usd double precision, created_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare prior text := coalesce(current_setting('app.benchmark_system', true), 'off');
begin
  perform set_config('app.benchmark_system', 'on', true);
  return query
  select r.run_id, a.attempt_id, r.user_id, u.display_name, u.github_login, r.harness_name, r.policy, r.model,
    c.case_id, c.kind, c.content_digest, c.arguments, c.prompt_system, c.prompt_user, p.reference,
    a.verdict, a.explanation, a.execution_status, a.execution_reason,
    (a.metrics->>'elapsed_ms')::float8, (a.metrics->>'input_tokens')::int8, (a.metrics->>'output_tokens')::int8,
    (select case when bool_or(d.status <> 'settled') then null else coalesce(sum(d.cost_usd), 0)::float8 end
       from public.benchmark_admission d where d.attempt_id = a.attempt_id),
    r.created_at
    from public.benchmark_run r join public.app_user u on u.id = r.user_id
    cross join lateral (select distinct on (x.case_id) x.* from public.benchmark_attempt x
      where x.run_id = r.run_id and x.case_id is not null order by x.case_id, x.attempt_no desc) a
    join public.benchmark_run_case c on c.run_id = r.run_id and c.case_id = a.case_id
    left join public.benchmark_run_private p on p.run_id = r.run_id and p.case_id = a.case_id
   where r.plugin_id = p_plugin_id and r.task_id = p_task_id and r.harness_name <> 'shell' and a.state = 'final' and a.verdict is not null
     and c.content_digest is not null
   order by r.created_at desc, r.run_id;
  perform set_config('app.benchmark_system', prior, true);
end
$$;
