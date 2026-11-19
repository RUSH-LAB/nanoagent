-- A free-form Terminal session is the same empty shell whichever plugin's page opened it: nothing of the plugin is opened or run for
-- it, so its run keeps the plugin's id alone, as the label of that page, and no version, package or task.
alter table benchmark_run alter column plugin_name drop not null;
alter table benchmark_run alter column version drop not null;
alter table benchmark_run alter column package_sha256 drop not null;
alter table benchmark_run alter column task_id drop not null;
alter table benchmark_run alter column task drop not null;
alter table benchmark_run add constraint benchmark_run_plugin_frame_check check (
  (plugin_name is null and version is null and package_sha256 is null and task_id is null and task is null)
  or (plugin_name is not null and version is not null and package_sha256 is not null and task_id is not null and task is not null));
