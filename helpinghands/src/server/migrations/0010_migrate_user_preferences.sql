insert or ignore into user_preferences ("userId", "value", "updatedAt")
select "ownerId", "value", "updatedAt"
from (
  select "ownerId", "value", "updatedAt",
         row_number() over (partition by "ownerId" order by "updatedAt" desc, rowid desc) as preference_rank
  from store_item
  where "domain" = 'preferences' and "key" = 'settings' and "ownerId" is not null
)
where preference_rank = 1;

delete from store_item where "domain" = 'preferences';
