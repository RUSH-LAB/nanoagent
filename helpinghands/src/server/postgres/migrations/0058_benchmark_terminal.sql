-- A plugin page's Harness tab session is a run a member works in: its harness runs interactively on a terminal the page shows.
-- `session` marks such a run, which the member's benchmark results do not list and whose claim tells the harness someone is at
-- its terminal.
alter table benchmark_run add column session boolean not null default false;
-- The sessions run before this column: a session's benchmark is the one no member publishes, and a published benchmark is never deleted.
alter table benchmark_run no force row level security;
alter table benchmark no force row level security;
update benchmark_run r set session = true where not exists (select 1 from benchmark b where b.benchmark_id = r.benchmark_id);
alter table benchmark force row level security;
alter table benchmark_run force row level security;

-- What an attempt's harness wrote to its terminal, in the order it came: each row the bytes from `byte_offset`. The worker API
-- appends them while the harness runs; a member reads them as they read the attempt's events.
create table benchmark_terminal (
  attempt_id uuid not null references benchmark_attempt(attempt_id) on delete cascade,
  byte_offset bigint not null check (byte_offset >= 0),
  data bytea not null check (octet_length(data) > 0),
  primary key (attempt_id, byte_offset)
);

-- What the member sends to that terminal, in order: keystrokes (`data`) or its new size (`rows`, `cols`). The worker reads them
-- after `seq` and writes them to the harness's terminal.
create table benchmark_terminal_input (
  attempt_id uuid not null references benchmark_attempt(attempt_id) on delete cascade,
  seq bigint not null check (seq >= 1),
  data bytea,
  rows integer,
  cols integer,
  primary key (attempt_id, seq),
  check ((data is not null and rows is null and cols is null) or (data is null and rows between 1 and 1000 and cols between 1 and 1000))
);

do $$
declare t text;
begin
  foreach t in array array['benchmark_terminal', 'benchmark_terminal_input'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (exists (select 1 from benchmark_attempt a where a.attempt_id = %I.attempt_id))', t || '_read', t, t);
    execute format('create policy %I on %I for all using (request_benchmark_system()) with check (request_benchmark_system())', t || '_write', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;
-- A member sends input to the terminal of their own session's attempt while it runs.
create policy benchmark_terminal_input_member on benchmark_terminal_input for insert with check (exists (
  select 1 from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id where a.attempt_id = benchmark_terminal_input.attempt_id and r.session and not a.sealed
));
