# Release policy

Git is the only synchronization boundary between local development and
production. Uncommitted files and feature branches never deploy.

## Branch rules

- Develop on feature branches in both repositories.
- `main` in Mochi and `master` in NanoAgent must always be deployable.
- Merge only after repository CI passes.
- Railway watches only those production branches.
- Never point a Railway service at a developer branch.

## Compatibility rules

- NanoAgent's `/v1` HTTP and SSE contract is backward compatible.
- Published profile IDs are stable identifiers. Do not rename or delete one
  without first shipping a Mochi migration and a temporary compatibility alias.
- The Mochi quality workflow checks out NanoAgent and runs a real streaming
  contract test against a deterministic fake model.
- NanoAgent's CI must validate its production configuration and container.

## Coordinated release

1. Develop and test both changes locally.
2. Merge NanoAgent first.
3. Wait for its Railway health check and verify `/health` and `/v1/profiles`.
4. Merge Mochi.
5. Verify sign-in, profile discovery, and one streamed assistant response.
6. If verification fails, roll back Mochi first and NanoAgent second using
   Railway's previous successful deployments.

Changes that preserve the current `/v1` contract and profile IDs may release
independently.

## Local and production isolation

- Local `npm start` starts the adjacent local NanoAgent checkout.
- Production Mochi must set `NANOAGENT_URL` and `NANOAGENT_API_TOKEN`.
- The production NanoAgent stores `OPENROUTER_API_KEY`; Mochi does not.
- NanoAgent has no public domain and is reachable only over Railway's private
  network.
