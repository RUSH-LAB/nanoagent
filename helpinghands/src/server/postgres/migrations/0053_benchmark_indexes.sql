-- Every claim sweeps unsettled admissions past their deadline and scans an endpoint's open runs oldest first
-- (src/server/postgres/benchmark-sweep.js, benchmark-worker.js): without these, both read every row ever written.
create index benchmark_admission_deadline_idx on benchmark_admission(deadline_at) where status <> 'settled';
create index benchmark_run_claim_idx on benchmark_run(endpoint_label, created_at, run_id) where canceled_at is null;
