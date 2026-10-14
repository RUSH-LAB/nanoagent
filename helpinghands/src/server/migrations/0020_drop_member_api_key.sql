-- Mochi keeps no member's API keys: the SQLite twin of PostgreSQL's migration 0023.

drop table if exists member_api_key;
