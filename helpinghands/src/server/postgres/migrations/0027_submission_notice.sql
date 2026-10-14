-- A workspace that takes submissions may say more than its statement: the terms
-- its home shows above the consent (site.submissions.notice), each a title and
-- its text. A submitter agrees to them with the statement, so a submission
-- records them as they read then, beside it.
alter table workspace_submission add column notice jsonb not null default '[]'::jsonb;
