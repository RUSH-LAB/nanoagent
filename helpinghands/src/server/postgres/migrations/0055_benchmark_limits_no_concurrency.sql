-- A run has no concurrency: how many attempts run at once is the local runner's own setting. Rows made before that
-- carry `concurrency` in the limits they pinned, and a claim hands those limits to the worker, whose request schema
-- refuses the key, so every such attempt faults. The key goes from every stored limits object (a benchmark's, a run's and
-- a preview's plan). A benchmark's `digest` stays as published: it names what was pinned, and a new publication of the
-- same configuration now digests differently. The trace's `attempt.started` events keep the limits as they were sent.
alter table benchmark no force row level security;
alter table benchmark_run no force row level security;
alter table benchmark_preview no force row level security;

update benchmark set limits = limits - 'concurrency' where limits ? 'concurrency';
update benchmark_run set limits = limits - 'concurrency' where limits ? 'concurrency';
update benchmark_preview set plan = jsonb_set(plan, '{limits}', (plan->'limits') - 'concurrency') where plan->'limits' ? 'concurrency';

alter table benchmark force row level security;
alter table benchmark_run force row level security;
alter table benchmark_preview force row level security;
