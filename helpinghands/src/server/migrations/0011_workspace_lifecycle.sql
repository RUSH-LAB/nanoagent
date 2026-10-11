alter table organization add column status text not null default 'active';
alter table organization add column createdBy text;
alter table organization add column archivedAt text;

create index if not exists organization_status_idx on organization (status);
