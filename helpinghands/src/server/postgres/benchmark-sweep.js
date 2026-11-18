'use strict';

const {SEAL} = require('./benchmark-context');

/**
 * Settle what time alone has ended, inside `client`'s transaction (a system transaction): attempts whose
 * lease ran out become interrupted keeping their evidence,
 * and reservations past their deadline settle at the reserved bound. Called by the claim, by the periodic
 * sweep and by member reads, so a member never sees an expired attempt as leased.
 *
 * Concurrent callers never wait on or deadlock with each other or with a renewal: each statement takes only
 * rows nobody holds (`skip locked`), in key order. A row a renewal holds is skipped, and the renewal
 * extends it or finds it expired and interrupts it itself. Row locks make the update re-check its
 * condition, so a renewal that committed first keeps its attempt leased.
 */
async function sweepExpired(client) {
  await client.query(
    `update benchmark_attempt set state = 'final', execution_status = 'interrupted', ${SEAL}
      where attempt_id in (select attempt_id from benchmark_attempt where state = 'leased' and lease_expires_at < now()
        order by attempt_id for update skip locked)`);
  await client.query(
    `update benchmark_admission set status = 'settled', cost_usd = reserve_usd, settled_at = now(),
       provenance = coalesce(provenance, '{}'::jsonb) || '{"settled_by":"deadline_sweep"}'::jsonb
      where (attempt_id, call_id) in (select attempt_id, call_id from benchmark_admission where status <> 'settled' and deadline_at < now()
        order by attempt_id, call_id for update skip locked)`);
}

module.exports = {sweepExpired};
