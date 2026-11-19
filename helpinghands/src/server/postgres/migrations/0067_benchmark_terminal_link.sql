-- A Harness tab session's page reaches its terminals on the member's own computer: the worker serves them on 127.0.0.1 (`port`),
-- to whoever has `token`, which RUSH hands only to the session's member. What they type no longer passes through RUSH, so the table
-- that carried it goes.
create table benchmark_terminal_link (
  attempt_id uuid primary key references benchmark_attempt(attempt_id) on delete cascade,
  port integer not null check (port between 1 and 65535),
  token text not null check (length(token) between 1 and 200)
);
alter table benchmark_terminal_link enable row level security;
create policy benchmark_terminal_link_read on benchmark_terminal_link for select using (exists (
  select 1 from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id
   where a.attempt_id = benchmark_terminal_link.attempt_id and r.user_id = request_user_id()
));
create policy benchmark_terminal_link_write on benchmark_terminal_link for all using (request_benchmark_system()) with check (request_benchmark_system());
alter table benchmark_terminal_link force row level security;

drop table benchmark_terminal_input;
