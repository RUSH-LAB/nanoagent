import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {coverageText, formatMs, primaryMetrics, timingRows} from '../../../../src/components/Benchmark/metrics.js';

describe('benchmark metrics', () => {
  it('lists the primary metrics first, tokens by class then total elapsed', () => {
    const rows = primaryMetrics({total_tokens: 1500, input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, elapsed_ms: 8300,
      missing_calls: {total: 0, input: 0, output: 1, cache_read: 0, cache_write: 2}});
    assert.deepEqual(rows.map(row => row.label), ['Total tokens', 'Input tokens', 'Output tokens', 'Cache reads', 'Cache writes', 'Total elapsed']);
    assert.deepEqual(rows.map(row => row.text), ['1,500', '1,000', '500', '0', '0', '8.30 s']);
    assert.equal(rows[2].missing, '1 call without it');
    assert.equal(rows[4].missing, '2 calls without it');
    assert.equal(rows[0].missing, null);
  });

  it('reads a run\'s sums as a known subtotal with the attempts that did not report', () => {
    const rows = primaryMetrics({total_tokens: {total: 90, missing_attempts: 1}, input_tokens: {total: 60, missing_attempts: 0}, elapsed_ms: {total: 61000, missing_attempts: 2}});
    assert.equal(rows[0].text, '90');
    assert.equal(rows[0].missing, '1 attempt without it');
    assert.equal(rows[1].missing, null);
    // A figure nobody reported is Unknown, never 0.
    assert.equal(rows[2].text, 'Unknown');
    assert.equal(rows[5].text, '1 m 1 s');
    assert.equal(rows[5].missing, '2 attempts without it');
  });

  it('labels the latency-adjusted estimate with its reference rate and says why a figure is Unknown', () => {
    const rows = timingRows({no_request_ns: 3e8, outside_waits_ns: null, outside_waits_ns_unknown: 'branch coverage is incomplete', cpu_ns: 5e9, estimated_ns: 6.3e9,
      timing_method: {reference_tokens_per_second: 100}});
    assert.deepEqual(rows.map(row => row.text), ['300 ms', 'Unknown', '5.00 s', '6.30 s']);
    assert.equal(rows[1].note, 'branch coverage is incomplete');
    assert.equal(rows[3].label, 'Estimated without OpenRouter latency (100 tokens/s)');
    assert.equal(rows[3].estimate, true);
    assert.deepEqual(timingRows(null), []);
  });

  it('withholds every timing figure with the reason the timing was unavailable', () => {
    const rows = timingRows({timing_unavailable: 'a clock was not recorded', timing_method: {reference_tokens_per_second: 50}});
    assert.ok(rows.every(row => row.text === 'Unknown' && row.note === 'a clock was not recorded'));
  });

  it('formats durations and coverage', () => {
    assert.equal(formatMs(340), '340 ms');
    assert.equal(formatMs(null), 'Unknown');
    assert.equal(coverageText({status: 'complete'}), 'Coverage complete');
    assert.equal(coverageText({status: 'partial', reasons: ['gateway lost', 'no collector']}), 'Coverage partial: gateway lost; no collector');
    assert.equal(coverageText({}), 'Coverage unknown');
  });
});
