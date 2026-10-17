-- Which NanoAgent a plugin run is on (src/server/app-runs.js): the member's
-- computer, which holds it across its connections, or RUSH Lab cloud
-- (src/server/cloud-runs.js), Mochi's own NanoAgent, where nothing holds it
-- once the process doing it stops. A run is written back, taken up and charged
-- on its own runner, whichever the member chooses meanwhile; every run before
-- this one was on a computer.
alter table plugin_run add column runner text not null default 'computer'
  check (runner in ('computer', 'cloud'));
