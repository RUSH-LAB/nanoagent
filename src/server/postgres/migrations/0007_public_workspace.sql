-- What a visitor who is not a member may learn about a workspace: its name and
-- the site settings its pages are laid out with, and only when it publishes at
-- least one node. Everything else stays behind membership and row-level security.
create or replace function public_workspace(p_slug text)
returns table(id text, name text, slug text, site jsonb)
language sql stable security definer set search_path = pg_catalog, public as $$
  select w.id, w.name, w.slug, coalesce(s.value, '{}'::jsonb)
    from public.workspace w
    left join public.workspace_settings s on s.workspace_id = w.id
   where w.slug = lower(p_slug) and w.status = 'active'
     and exists (
       select 1 from public.fs_node n
        where n.workspace_id = w.id and n.access = 'public' and n.deleted_at is null
     )
$$;
revoke execute on function public_workspace(text) from public;
