-- Invitations addressed to a GitHub account rather than an email address
-- (org.js), beside Better Auth's workspace_invitation. Better Auth accepts an
-- invitation only from the session whose email it names, so these are kept and
-- accepted by Mochi, and the membership is still Better Auth's to create. Like
-- workspace_invitation this is control-plane data outside row-level security:
-- the routes check that the caller owns the workspace. The account is GitHub's
-- numeric id, resolved from the username when the invitation is made, because a
-- username can be renamed and then claimed by someone else; the username is
-- kept to show.
create table workspace_github_invitation (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  github_id text not null,
  github_login text not null,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'canceled')),
  expires_at timestamptz not null,
  invited_by text not null references app_user(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index workspace_github_invitation_workspace_idx on workspace_github_invitation(workspace_id, status);
create index workspace_github_invitation_github_idx on workspace_github_invitation(github_id, status);

-- Whether a GitHub username holds a live invitation, which is what invite-only
-- sign-up asks of an account GitHub is about to create.
create or replace function signup_github_invitation_exists(p_login text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.workspace_github_invitation
                  where lower(github_login) = lower(p_login) and status = 'pending' and expires_at > now())
$$;
revoke execute on function signup_github_invitation_exists(text) from public;
