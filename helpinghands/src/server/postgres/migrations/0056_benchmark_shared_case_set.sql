-- A case set is shared by every benchmark that publishes identical content, so it outlives its first publisher: deleting
-- that publisher's account leaves it in place, with no publisher, instead of failing on the other publishers' benchmarks.
alter table benchmark_case_set alter column publisher_id drop not null;
alter table benchmark_case_set drop constraint benchmark_case_set_publisher_id_fkey;
alter table benchmark_case_set add constraint benchmark_case_set_publisher_id_fkey foreign key (publisher_id) references app_user(id) on delete set null;

-- A member keeps only their newest previews (savePreview prunes the rest), so previews cannot pile up.
create policy benchmark_preview_delete on benchmark_preview for delete using (user_id = request_user_id());
