-- How a call's time went: the seconds its agent spent on model requests and
-- on tool calls, the rest of its duration_s being NanoAgent's own. Null where
-- it is not known, as for the calls recorded before it was.
alter table ai_usage add column model_s double precision check (model_s >= 0);
alter table ai_usage add column tools_s double precision check (tools_s >= 0);
