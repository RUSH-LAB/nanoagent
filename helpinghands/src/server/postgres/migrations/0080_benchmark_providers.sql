-- The model's providers a benchmark is pinned to, in order (RUSH_BENCHMARK_PROVIDERS), kept with it and copied onto each run as its model
-- is: the gateway sends them as OpenRouter's provider order, without fallbacks. Benchmarks and runs made before take the default order.
alter table benchmark add column providers text[] not null default '{deepinfra,nebius}';
alter table benchmark alter column providers drop default;
alter table benchmark_run add column providers text[] not null default '{deepinfra,nebius}';
alter table benchmark_run alter column providers drop default;
