# Release policy

Git is the only synchronization boundary between local development and
production. Uncommitted files and development branches never deploy.

## Branch rules

- Mochi (`helping-hands/`) and NanoAgent (`nanoagent/`) share one repository,
  `zeyuyang8/helpinghands`.
- `production` is what Railway runs and must always be deployable. Change it
  only by merging a pull request after CI passes; never push to it directly.
- Develop on another branch and open a pull request into `production` when it
  is ready.
- Railway watches only `production`. The Mochi service builds from
  `helping-hands/` and the NanoAgent service from `nanoagent/`; each redeploys
  only when its own directory changes.
- Never deploy with `railway up` from a working tree.

## Compatibility rules

- NanoAgent's `/v1` HTTP and SSE contract is backward compatible.
- Published profile IDs are stable identifiers. Do not rename or delete one
  without first shipping a Mochi migration and a temporary compatibility alias.
- Change the contract in two steps. NanoAgent first adds the new form and
  keeps the old one, marked `COMPAT(<name>)`; Mochi then moves to the new form;
  a later NanoAgent release removes everything marked with that name.
- `npm run nanoagent:verify` exercises every call of Mochi's NanoAgent client
  (`createNanoAgentGateway`) against a live NanoAgent and a deterministic fake
  model, and fails when a client method has no check. NanoAgent is started from
  its own `deploy/contract/nanoagent.yaml`, so any Mochi checkout can run
  against any NanoAgent checkout (`NANOAGENT_PROJECT_DIR`).
- The Mochi quality workflow runs that check for the pull request's own pair,
  and across versions for whichever side changed: this Mochi against
  production's NanoAgent, and production's Mochi against this NanoAgent. A pull
  request whose Mochi needs a NanoAgent change that is not in production yet
  fails the first, which is the signal to release NanoAgent alone first.
- NanoAgent's CI must validate its production configuration and container.

## Coordinated release

1. Develop and test both changes locally.
2. Merge a pull request with only the NanoAgent change first.
3. Wait for its Railway health check and verify `/health` and `/v1/profiles`.
4. Merge the Mochi change.
5. Verify sign-in, profile discovery, and one streamed assistant response.
6. If verification fails, roll back Mochi first and NanoAgent second using
   Railway's previous successful deployments.

Changes that preserve the current `/v1` contract and profile IDs may release
independently.

## Local and production isolation

- Local `npm start` starts the adjacent `nanoagent/` checkout.
- Production Mochi must set `NANOAGENT_URL` and `NANOAGENT_API_TOKEN`.
- The production NanoAgent stores `OPENROUTER_API_KEY`; Mochi does not.
- NanoAgent has no public domain and is reachable only over Railway's private
  network.
