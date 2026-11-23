-- Preserve reported tool-call counts in the bounded run summary.
create or replace view benchmark_run_summary with (security_invoker = true) as
select r.run_id, r.benchmark_id, r.harness_name, r.benchmark_name, r.plugin_id, r.plugin_name, r.version as plugin_version,
  r.model, r.user_id, u.display_name as user_name, u.github_login as user_github, r.canceled_at, r.created_at,
  (select coalesce(array_agg(c.case_id order by c.position), '{}') from benchmark_run_case c where c.run_id = r.run_id) as case_ids,
  (select coalesce(jsonb_agg(jsonb_build_object('case_id', a.case_id, 'attempt_no', a.attempt_no, 'state', a.state, 'verdict', a.verdict,
      'execution_status', a.execution_status,
      'verifier_error', a.verifier_error is not null, 'metrics', case when a.metrics is null then null else jsonb_strip_nulls(jsonb_build_object(
        'total_tokens', a.metrics->'total_tokens', 'input_tokens', a.metrics->'input_tokens', 'output_tokens', a.metrics->'output_tokens',
        'cache_read_tokens', a.metrics->'cache_read_tokens', 'cache_write_tokens', a.metrics->'cache_write_tokens', 'elapsed_ms', a.metrics->'elapsed_ms',
        'tool_calls', a.metrics->'tool_calls',
        'missing_calls', jsonb_build_object('total', a.metrics->'missing_calls'->'total', 'input', a.metrics->'missing_calls'->'input',
          'output', a.metrics->'missing_calls'->'output', 'cache_read', a.metrics->'missing_calls'->'cache_read',
          'cache_write', a.metrics->'missing_calls'->'cache_write'))) end)), '[]'::jsonb)
    from (select distinct on (x.case_id) x.* from benchmark_attempt x where x.run_id = r.run_id order by x.case_id, x.attempt_no desc) a) as attempts
  from benchmark_run r join app_user u on u.id = r.user_id;
