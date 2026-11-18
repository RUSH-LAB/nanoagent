-- A Terminal session resumes one of the member's ended ones, clicked on the plugin page's Dashboard: its worker keeps each ended
-- session's workspace (with the agent CLIs' state) on the member's computer, never on RUSH, and tells RUSH only whether it kept it
-- (`resumable`, at finalize). The session that resumes one is a new run, linked to the attempt it resumes (`resumed_from`).
alter table benchmark_attempt add column resumable boolean not null default false;
alter table benchmark_run add column resumed_from uuid references benchmark_attempt(attempt_id) on delete set null;
