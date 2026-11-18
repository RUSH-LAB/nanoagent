-- A Harness tab session has terminals the member opens and closes (0 the first, up to 31), all in the session's one VM: each one's
-- output is its own (`terminal`), what the member sends goes to one of them, and `close` asks the worker to close one. The worker
-- records each terminal that ended in benchmark_terminal_closed, after its last output.
alter table benchmark_terminal add column terminal integer not null default 0 check (terminal between 0 and 31);
alter table benchmark_terminal drop constraint benchmark_terminal_pkey, add primary key (attempt_id, terminal, byte_offset);

alter table benchmark_terminal_input add column terminal integer not null default 0 check (terminal between 0 and 31),
  add column close boolean not null default false;
alter table benchmark_terminal_input drop constraint benchmark_terminal_input_check, add check (
  (data is not null and rows is null and cols is null and not close)
  or (data is null and rows between 1 and 1000 and cols between 1 and 1000 and not close)
  or (data is null and rows is null and cols is null and close)
);

create table benchmark_terminal_closed (
  attempt_id uuid not null references benchmark_attempt(attempt_id) on delete cascade,
  terminal integer not null check (terminal between 0 and 31),
  primary key (attempt_id, terminal)
);
alter table benchmark_terminal_closed enable row level security;
create policy benchmark_terminal_closed_read on benchmark_terminal_closed for select using (exists (
  select 1 from benchmark_attempt a where a.attempt_id = benchmark_terminal_closed.attempt_id
));
create policy benchmark_terminal_closed_write on benchmark_terminal_closed for all using (request_benchmark_system()) with check (request_benchmark_system());
alter table benchmark_terminal_closed force row level security;
