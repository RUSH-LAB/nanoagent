'use strict';
/**
 * Every assistant call is charged to the workspace it runs in and the member
 * who made it, and refused once either has spent its budget
 * (postgres/tenancy.js).
 *
 * NanoAgent prices a completed call. A call it did not price, such as a stream
 * the caller abandoned after text arrived, or an app task run, whose events
 * carry no cost, is charged at NanoAgent's per-run cap instead, so neither is
 * a way around the budget.
 */

// agent.cost_limit in nanoagent/deploy/railway/nanoagent.yaml.
const UNPRICED_RUN_USD = 0.10;

/** A meter over the tenancy module; without PostgreSQL there are no budgets. */
function createAiMeter(tenancy) {
  return Object.freeze({
    /** Throws a TenancyError (status 429) when the budget is spent. */
    async assertAllowed(context) {
      if (tenancy) await tenancy.assertAiAllowed(context);
    },

    /**
     * Record one call. `result` is what ai.js returned, or null when the call
     * threw; `ran` says whether it got far enough to cost anything.
     */
    async record(context, kind, result, {ran}) {
      if (!tenancy) return;
      const priced = result?.cost != null;
      if (!priced && !ran) return;
      await tenancy.recordAiUsage(context, {
        kind,
        model: result?.model ?? null,
        cost: priced ? result.cost : UNPRICED_RUN_USD,
        usage: result?.usage ?? null,
        estimated: !priced,
      });
    },
  });
}

/** The reply for a refused call: the budget message, or null for any other error. */
function budgetRefusal(error) {
  return error?.name === 'TenancyError' ? {status: error.status, body: {error: error.message, code: error.code}} : null;
}

module.exports = {createAiMeter, budgetRefusal, UNPRICED_RUN_USD};
