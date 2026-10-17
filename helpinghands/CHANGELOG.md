# Changelog

What each Mochi release changes, one sentence each.

## Unreleased

- A site can offer RUSH Lab cloud (`CLOUD_RUNS=on`): members who choose it run plugins on a sandboxed NanoAgent with nothing to install, and `infra/aws/` deploys such a site to AWS.
- Opening a link to a workspace you are not in no longer says the API server cannot be reached.
- A plugin install that RUSH Lab moved into a member's connection is built again where it is now, instead of failing with "Connection closed".
- New accounts start with arxiv-source and weather-alert installed (src/server/preinstalled-plugins.yaml).
- RUSH Lab installs once per computer account and connects each member separately, so several accounts can be connected from one laptop at once.
- The site opens only once RUSH Lab on your computer is connected, Settings → Connection shows whether it is, and `npm start`'s site installs RUSH Lab built from the checkout, beside rush-lab.org's, with keys from its own $10 OpenRouter workspace.
- Plugins are now installed by each user for themselves, and `npm start` runs on a local copy of production's database that `npm run db:pull` refreshes and `npm run db:push -- <slug>` sends one workspace of back.
