-- The hint of the OpenRouter key Mochi made a member (how it begins and ends, as
-- Mochi Lab shows a key): it tells Settings → AI the computer still holds that
-- key, to show what is spent of its credit. A key made before has none ('').
alter table openrouter_grant add column hint text not null default '';
alter table openrouter_grant alter column hint drop default;
