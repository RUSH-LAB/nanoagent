'use strict';
/**
 * Every assistant call is charged to the workspace it runs in and the member
 * who made it, and refused once either has spent its budget
 * (postgres/tenancy.js).
 *
 * NanoAgent prices a completed call. A call it did not price, such as a stream
 * the caller abandoned after text arrived, or a task run that failed or was
 * stopped, is charged at NanoAgent's per-run cap instead, so neither is a way
 * around the budget.
 *
 * A call to the member's own computer (server/runner.js) is theirs to pay for:
 * it is never refused, and is recorded at no cost.
 */

// agent.cost_limit in nanoagent/deploy/railway/nanoagent.yaml.
const UNPRICED_RUN_USD = 0.10;

/** A meter over the tenancy module; without PostgreSQL there are no budgets. */
function createAiMeter(tenancy) {
  return Object.freeze({
    /** Throws a TenancyError (status 429) when the budget is spent. */
    async assertAllowed(context, {local = false} = {}) {
      if (tenancy && !local) await tenancy.assertAiAllowed(context);
    },

    /**
     * Record one call. `result` is what ai.js returned, or null when the call
     * threw; `ran` says whether it got far enough to cost anything. A plugin's
     * call names the plugin, its session, and for a task run the task; `local`
     * says it ran on the member's own computer.
     */
    async record(context, kind, result, {ran, local = false, pluginId = null, sessionId = null, task = null}) {
      if (!tenancy) return;
      const priced = result?.cost != null;
      if (!priced && !ran) return;
      await tenancy.recordAiUsage(context, {
        kind,
        model: result?.model ?? null,
        cost: local ? 0 : priced ? result.cost : UNPRICED_RUN_USD,
        usage: result?.usage ?? null,
        metrics: result?.metrics ?? null,
        estimated: !local && !priced,
        pluginId,
        sessionId,
        task,
      });
    },
  });
}

/** The reply for a refused call: the budget message, or null for any other error. */
function budgetRefusal(error) {
  return error?.name === 'TenancyError' ? {status: error.status, body: {error: error.message, code: error.code}} : null;
}

module.exports = {createAiMeter, budgetRefusal, UNPRICED_RUN_USD};
