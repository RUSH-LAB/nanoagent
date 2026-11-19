-- A new Terminal session started from the plugin page's Dashboard under an agent (New session with its chip chosen) runs that agent's
-- CLI in its first terminal: its command (`claude`), which the worker's claim carries (`start`).
alter table benchmark_run add column start_cli text;
