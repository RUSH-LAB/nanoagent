-- A Harness tab session's run is queued before its one case is pinned, so its harness starts while the member's computer fills
-- and pins the case. Until then the case has no arguments, digest or prompt and the run no case set; `pin_error` is why a pin failed.
alter table benchmark_run alter column case_set_id drop not null, alter column case_set_digest drop not null;
alter table benchmark_run_case alter column arguments drop not null, alter column content_digest drop not null, alter column prompt_sha256 drop not null,
  add column pin_error text;
alter table benchmark_run_case drop constraint benchmark_run_case_check;
alter table benchmark_run_case add constraint benchmark_run_case_pinned check (
  (arguments is not null and content_digest is not null and prompt_sha256 is not null and (prompt_system is not null or prompt_user is not null) and pin_error is null)
  or (arguments is null and content_digest is null and prompt_sha256 is null and prompt_system is null and prompt_user is null)
);
