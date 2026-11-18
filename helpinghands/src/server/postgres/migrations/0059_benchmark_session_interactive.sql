-- `session` now marks every run of a plugin page's Harness tab or of `nanoagent harness`, which are never benchmark results, the
-- one-shot ones too; `interactive` marks the ones a member works in at the harness's terminal, as `session` did before.
alter table benchmark_run add column interactive boolean not null default false;
alter table benchmark_run no force row level security;
alter table benchmark no force row level security;
update benchmark_run set interactive = session;
-- A session's benchmark is the one no member publishes, and a published benchmark is never deleted.
update benchmark_run r set session = true where not exists (select 1 from benchmark b where b.benchmark_id = r.benchmark_id);
alter table benchmark force row level security;
alter table benchmark_run force row level security;
