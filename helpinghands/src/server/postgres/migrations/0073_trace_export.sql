-- The trace export (routes/trace-export.js) dumps the NanoAgent chats of a plugin page (plugin_session) beside the benchmark runs: a
-- member's own, or for a platform administrator everyone's. plugin_session is each member's alone, so the chats an export lists come
-- from this function, as the owner, which gives a member their own (in a workspace they are still in) and an administrator any member's.
-- Each chat's turns are then read as its member (fs/chats.js).
do $$
begin
  execute format('create policy plugin_session_owner_read on plugin_session for select to %I using (true)', current_user);
end $$;

create function plugin_session_export(p_user_id text, p_plugin_id text, p_since timestamptz, p_until timestamptz)
returns table (id text, workspace_id text, user_id text, user_name text, user_github text, plugin_id text, title text, chat_file text,
  created_at timestamptz, updated_at timestamptz, archived_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public as $$
  select s.id, s.workspace_id, s.user_id, u.display_name, u.github_login, s.plugin_id, s.title, s.chat_file, s.created_at, s.updated_at, s.archived_at
    from public.plugin_session s join public.app_user u on u.id = s.user_id
   where (p_user_id is null or s.user_id = p_user_id) and (p_plugin_id is null or s.plugin_id = p_plugin_id)
     and (p_since is null or s.created_at >= p_since) and (p_until is null or s.created_at < p_until)
     and (exists (select 1 from public.platform_admin pa where pa.user_id = public.request_user_id())
       or (s.user_id = public.request_user_id() and public.is_workspace_member(s.workspace_id)))
   order by s.created_at, s.id
$$;
