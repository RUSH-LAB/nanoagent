-- Better Auth's device-authorization plugin (auth.js): the codes the
-- command-line client signs in with. Better Auth owns it, like auth_session.
create table auth_device_code (
  id text primary key,
  device_code text not null unique,
  user_code text not null unique,
  user_id text references app_user(id) on delete cascade,
  expires_at timestamptz not null,
  status text not null,
  last_polled_at timestamptz,
  polling_interval integer,
  client_id text,
  scope text
);
