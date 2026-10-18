-- A plugin session is with a plugin the member installed, or with their draft
-- of one, which their RUSH Lab installed from the folder they make it in
-- (src/runner/lab.mjs): each lists, resumes and runs only sessions of its own
-- kind, so a draft of a plugin they installed keeps a history of its own.
alter table plugin_session add column draft boolean not null default false;
