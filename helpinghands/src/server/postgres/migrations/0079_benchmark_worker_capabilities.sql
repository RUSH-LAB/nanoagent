-- Keep each worker's advertised capabilities independently for the same member and endpoint.
alter table benchmark_worker_capability drop constraint benchmark_worker_capability_pkey;
alter table benchmark_worker_capability add primary key (user_id, endpoint_label, worker_id);
