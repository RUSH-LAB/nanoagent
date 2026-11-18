-- A Harness tab Terminal session (or `nanoagent harness harness=shell` with someone at it) is free-form: the member runs any agent and
-- prompts it themselves, so its run has no case set and no case, and its one attempt is of no case. It ends `ended`, unscored, keeping
-- its model calls and commands.
alter table benchmark_attempt alter column case_id drop not null;
alter table benchmark_attempt drop constraint benchmark_attempt_execution_status_check;
alter table benchmark_attempt add constraint benchmark_attempt_execution_status_check check (execution_status in
  ('answered', 'refused', 'execution_failed', 'build_failed', 'canceled', 'interrupted', 'ended'));
