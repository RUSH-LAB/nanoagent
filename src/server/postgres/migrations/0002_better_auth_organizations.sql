-- Better Auth owns the organization control plane in every database mode.
-- These three tables therefore follow the same trust boundary as app_user,
-- auth_session, auth_account, and auth_verification: Better Auth performs the
-- authorization checks, while product/business tables remain protected by RLS.

alter table workspace add column if not exists metadata text;

update workspace_invitation set status = 'canceled' where status = 'cancelled';
alter table workspace_invitation drop constraint if exists workspace_invitation_status_check;
alter table workspace_invitation add constraint workspace_invitation_status_check
  check (status in ('pending', 'accepted', 'rejected', 'canceled', 'expired'));

drop policy if exists workspace_member_read on workspace;
drop policy if exists workspace_owner_update on workspace;
drop policy if exists workspace_owner_delete on workspace;
drop policy if exists workspace_member_read on workspace_member;
drop policy if exists workspace_member_self_discovery on workspace_member;
drop policy if exists workspace_member_insert on workspace_member;
drop policy if exists workspace_member_update on workspace_member;
drop policy if exists workspace_member_delete on workspace_member;
drop policy if exists workspace_invitation_read on workspace_invitation;
drop policy if exists workspace_invitation_write on workspace_invitation;

alter table workspace disable row level security;
alter table workspace_member disable row level security;
alter table workspace_invitation disable row level security;

-- These write helpers duplicated Better Auth's organization and invitation
-- lifecycle and are deliberately retired. Read-only helpers used by scoped
-- discovery remain available.
drop function if exists create_workspace_with_owner(text, text);
drop function if exists accept_workspace_invitation(text);
drop function if exists invitation_preview(text);
