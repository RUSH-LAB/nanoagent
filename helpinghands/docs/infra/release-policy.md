# Release policy

Code reaches production only through git: uncommitted files and branches
other than `production` never deploy. Data crosses only when asked: local
`npm start` runs on its own copy of production's database, which `db:pull`
refreshes and `db:push` sends one workspace of back
([neon-postgres-setup.md](neon-postgres-setup.md)). Production's schema changes
only by Railway's deploy.

## Branch rules

- RUSH (`helpinghands/`) and NanoAgent (`nanoagent/`) share one repository,
  `RUSH-LAB/nanoagent`.
- `production` is what Railway runs and must always be deployable. Change it
  only by merging a pull request after CI passes; never push to it directly.
- `devmode` collects what is ready to release next. Develop on another branch
  and open a pull request into `devmode`. CI runs only on pull requests into
  either branch: a push runs nothing, so run `npm test` before pushing.
- Release by opening one pull request from `devmode` into `production`. No
  other branch goes into `production`.
- Railway watches only `production`. The RUSH service builds from
  `helpinghands/` and the NanoAgent service from `nanoagent/`; each redeploys
  only when its own directory changes.
- Never deploy with `railway up` from a working tree.

## Compatibility rules

- NanoAgent's `/v1` HTTP and SSE contract is backward compatible.
- Published profile IDs are stable identifiers. Do not rename or delete one
  without first shipping a RUSH migration and a temporary compatibility alias.
- Change the contract in two steps. NanoAgent first adds the new form and
  keeps the old one, marked `COMPAT(<name>)`; RUSH then moves to the new form;
  a later NanoAgent release removes everything marked with that name.
- `npm run nanoagent:verify` exercises every call of RUSH's NanoAgent client
  (`createNanoAgentGateway`) against a live NanoAgent and a deterministic fake
  model, and fails when a client method has no check. NanoAgent is started from
  its own `deploy/contract/nanoagent.yaml`, whose only package is the plugin the
  check installs (the check reads its folder and id there), so any RUSH
  checkout can run against any NanoAgent checkout (`NANOAGENT_PROJECT_DIR`).
- The RUSH quality workflow runs that check for the pull request's own pair,
  and across versions for whichever side changed: this RUSH against
  production's NanoAgent, and production's RUSH against this NanoAgent. A pull
  request whose RUSH needs a NanoAgent change that is not in production yet
  fails the first, which is the signal to release NanoAgent alone first.
- NanoAgent's CI must validate its production configuration and container.

## Migrations

- Railway applies RUSH's pending migrations before the new container starts,
  all in one transaction: if one fails, none is applied, and the running
  deployment keeps the schema it was built for.
- A pull request into `production` runs the pending migrations against
  production's data, on a Neon branch made from it and deleted after
  (`production-data` in the PostgreSQL workflow, with the `NEON_API_KEY`
  secret), so a migration that fails on real rows fails before merging.

## Coordinated release

1. Develop and test both changes locally.
2. Merge a pull request with only the NanoAgent change first.
3. Wait for its Railway health check and verify `/health` and `/v1/profiles`.
4. Merge the RUSH change.
5. Verify sign-in, profile discovery, and one streamed assistant response.
6. If verification fails, roll back RUSH first and NanoAgent second using
   Railway's previous successful deployments.

Changes that preserve the current `/v1` contract and profile IDs may release
independently.

## Local and production isolation

- Local `npm start` starts the adjacent `nanoagent/` checkout.
- Production RUSH must set `NANOAGENT_URL` and `NANOAGENT_API_TOKEN`.
- Neither the production NanoAgent nor RUSH stores a model-provider key: each
  member's RUSH Lab holds its own.
- NanoAgent has no public domain and is reachable only over Railway's private
  network.
