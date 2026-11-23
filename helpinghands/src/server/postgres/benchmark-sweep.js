'use strict';
const {MAX_ATTEMPTS_PER_CASE, MAX_WORKER_ATTEMPTS} = require('../benchmark/limits');

/**
 * Queue the next attempt of each case whose attempt among `attemptIds` ended `worker_error`, inside the transaction that ended it: the
 * case's attempt number plus one, a rerun of it, until the case's newest MAX_WORKER_ATTEMPTS attempts in a row ended so. Only worker errors
 * count, not the member's own reruns before them (attempt numbers count both), and never past MAX_ATTEMPTS_PER_CASE. A free-form session has
 * no case, and a canceled run takes no new attempts. Inserting takes only a key share of the run, which a cancel (it locks the run `for no
 * key update`) does not wait on. A retry is never left queued in a canceled run, though the `canceled_at` test reads a snapshot: the caller holds
 * the ended attempt's row, and a cancel, after taking the run, updates its leased attempts before its queued ones, so it either waits for that
 * row and then cancels the retry queued here, or commits first and is seen by the statement below (the interleavings are in benchmark-acceptance.mjs).
 */
async function retryWorkerErrors(client, attemptIds) {
  await client.query(
    `insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, rerun_of)
     select gen_random_uuid(), a.run_id, a.case_id, a.attempt_no + 1, a.attempt_id
       from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id
      where a.attempt_id = any($1::uuid[]) and a.execution_status = 'worker_error' and a.case_id is not null
        and a.attempt_no < $3 and r.canceled_at is null
        and (select count(*) from benchmark_attempt b
              where b.run_id = a.run_id and b.case_id = a.case_id and b.attempt_no <= a.attempt_no
                and b.attempt_no > coalesce((select max(c.attempt_no) from benchmark_attempt c
                                              where c.run_id = a.run_id and c.case_id = a.case_id and c.attempt_no < a.attempt_no
                                                and c.execution_status is distinct from 'worker_error'), 0)) < $2
     on conflict do nothing`, [attemptIds, MAX_WORKER_ATTEMPTS, MAX_ATTEMPTS_PER_CASE]);
}

/**
 * End the leased attempts `attemptIds` (locked by the caller), whose lease ran out, keeping what they committed: a case attempt as a
 * worker error (its worker died), retried by `retryWorkerErrors`, a free-form session as interrupted.
 */
async function expireLeases(client, attemptIds) {
  await client.query(
    `update benchmark_attempt set state = 'final', finalized_at = now(), sealed = true, final_cursor = next_cursor - 1,
       execution_status = case when case_id is null then 'interrupted' else 'worker_error' end,
       execution_reason = case when case_id is null then null else 'The worker stopped renewing the attempt''s lease' end
      where attempt_id = any($1::uuid[])`, [attemptIds]);
  await retryWorkerErrors(client, attemptIds);
}

/**
 * Settle what time alone has ended, inside `client`'s transaction (a system transaction): attempts whose
 * lease ran out end keeping their evidence (`expireLeases`),
 * and reservations past their deadline settle at the reserved bound. Called by the claim, by the periodic
 * sweep and by member reads, so a member never sees an expired attempt as leased.
 *
 * Concurrent callers never wait on or deadlock with each other or with a renewal: each statement takes only
 * rows nobody holds (`skip locked`), in key order. A row a renewal holds is skipped, and the renewal
 * extends it or finds it expired and interrupts it itself. Row locks make the update re-check its
 * condition, so a renewal that committed first keeps its attempt leased.
 */
async function sweepExpired(client) {
  const expired = (await client.query(
    `select attempt_id from benchmark_attempt where state = 'leased' and lease_expires_at < now() order by attempt_id for update skip locked`,
  )).rows.map(row => row.attempt_id);
  if (expired.length) await expireLeases(client, expired);
  await client.query(
    `update benchmark_admission set status = 'settled', cost_usd = reserve_usd, settled_at = now(),
       provenance = coalesce(provenance, '{}'::jsonb) || '{"settled_by":"deadline_sweep"}'::jsonb
      where (attempt_id, call_id) in (select attempt_id, call_id from benchmark_admission where status <> 'settled' and deadline_at < now()
        order by attempt_id, call_id for update skip locked)`);
}

module.exports = {expireLeases, retryWorkerErrors, sweepExpired};
