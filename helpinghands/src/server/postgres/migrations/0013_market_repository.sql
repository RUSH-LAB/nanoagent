-- Where a marketplace plugin's source lives (routes/market.js, server/github.js):
-- {owner, repo, ref, path, commit}, the GitHub repository it was published
-- from, the ref and folder named then, and the commit that ref was. The package
-- is that commit's folder, packed. Plugins uploaded as files before publishing
-- went through GitHub have none.
alter table market_plugin add column repository jsonb;
