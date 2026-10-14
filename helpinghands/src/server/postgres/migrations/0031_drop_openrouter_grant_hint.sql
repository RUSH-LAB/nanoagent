-- Settings → AI asks the member's computer what its OpenRouter key has spent
-- (GET /v1/keys/openrouter/usage), for whichever key it holds: Mochi needs no
-- hint to tell its own key from theirs any more.
alter table openrouter_grant drop column hint;
