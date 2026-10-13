-- A member's own provider API keys, kept by Mochi: the SQLite twin of PostgreSQL's
-- migration 0021 (postgres/member-keys.js). Each value is AES-256-GCM ciphertext.

create table if not exists member_api_key (
  user_id text not null references "user" ("id") on delete cascade,
  env text not null,
  ciphertext text not null,
  hint text not null,
  updated_at text not null,
  primary key (user_id, env)
);
