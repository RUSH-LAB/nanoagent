import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The toast store is authored as an ES module under src/components (consumed by
// the Docusaurus build) and powers the in-app notification UI. Node's
// module-syntax detection lets this .mjs test import the .js source directly and
// read its named exports, so every assertion below pins the REAL store rather
// than a reimplementation. A harmless MODULE_TYPELESS_PACKAGE_JSON warning is
// expected on import and does not affect the result.
import { toast, getToasts } from '../../../../../../src/components/Toast/toast.js';

// Characterization test for two behaviors the existing suite leaves uncovered.
// tests/next-toast-store.test.mjs passes { duration: 0 } on every call, so the
// `duration > 0` setTimeout branch in add() never schedules, and it exercises
// only the success and error variants. The cases below pin that auto-remove
// timer (the 3000ms default and an explicit positive duration) and the
// 'warning' / 'info' type strings.
//
// The module keeps process-level state: an incrementing id and a toasts array.
// Node isolates each test file in its own process, so the state starts fresh
// here, but it PERSISTS across the it blocks below. Each case therefore locates
// its own entry by the id returned from the toast call instead of assuming the
// store is empty or that ids take any absolute value. Fake timers come from the
// per-test context `t`, which restores them automatically when the test ends.
describe('toast store auto-remove timer and type variants', () => {
  it('auto-removes a default-duration toast once 3000ms elapse', (t) => {
    // Drive the auto-remove setTimeout deterministically with fake timers.
    t.mock.timers.enable({ apis: ['setTimeout'] });

    // With no duration option, add() falls back to the 3000ms default and
    // schedules remove(id) at that delay.
    const id = toast.info('default duration');

    // The entry is live immediately after the add, before the clock advances.
    assert.ok(getToasts().some((entry) => entry.id === id));

    // Advancing the full default duration fires the scheduled remove.
    t.mock.timers.tick(3000);
    assert.ok(!getToasts().some((entry) => entry.id === id));
  });

  it('auto-removes an explicit positive-duration toast at its delay', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    // An explicit positive duration schedules remove(id) at exactly 1500ms.
    const id = toast.success('explicit duration', { duration: 1500 });
    assert.ok(getToasts().some((entry) => entry.id === id));

    // One millisecond short of the delay the entry is still present, which
    // shows the removal is bound to the duration and does not fire early.
    t.mock.timers.tick(1499);
    assert.ok(getToasts().some((entry) => entry.id === id));

    // Reaching the full delay removes it.
    t.mock.timers.tick(1);
    assert.ok(!getToasts().some((entry) => entry.id === id));
  });

  it('tags entries with their warning and info type', (t) => {
    // These default-duration toasts each schedule an auto-remove timer. Enabling
    // fake timers keeps those off the real event loop; they are discarded when
    // the test context restores its mocks, after the types are asserted.
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const warningId = toast.warning('warned');
    const infoId = toast.info('informed');

    const warningEntry = getToasts().find((entry) => entry.id === warningId);
    const infoEntry = getToasts().find((entry) => entry.id === infoId);

    assert.strictEqual(warningEntry.type, 'warning');
    assert.strictEqual(infoEntry.type, 'info');
  });
});
