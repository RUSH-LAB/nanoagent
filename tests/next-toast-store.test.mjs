import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// The toast store is authored as an ES module under src/components (consumed by
// the Docusaurus build) and powers the in-app notification UI. Node's
// module-syntax detection lets this .mjs test import the .js source directly and
// read its named exports, so every golden below pins the REAL store instead of a
// reimplementation.
import { toast, getToasts, subscribe } from '../src/components/Toast/toast.js';

// Characterization test: it locks the CURRENT public behavior of the store.
// The module keeps process-level state (an incrementing id, a toasts array, a
// subscriber Set). Node's test runner isolates each test file in its own
// process, and no other test imports this module, so the state starts fresh
// here: the first add is id 1, the second is id 2, and so on. A single `before`
// hook drives every mutation in one fixed order and records snapshots; each
// `it` then asserts a recorded value, which keeps the id sequence deterministic
// no matter what order the cases run in. Every toast call passes
// `{ duration: 0 }` so the `duration > 0` branch is skipped and no setTimeout
// is scheduled, keeping the whole run synchronous and free of pending timers.
describe('toast store add subscribe and dismiss', () => {
  // A stable function reference for the action-bearing entry (behavior 3).
  const actionFn = () => 'undo';

  // Behavior 1: fresh state.
  let firstFresh;
  let secondFresh;

  // Behavior 2: first add (success, default action fields).
  let successId;
  let afterSuccess;

  // Behavior 3: second add (error, action-bearing).
  let errorId;
  let afterError;

  // Behavior 5: dismiss by id.
  let afterDismiss;

  // Behavior 4: subscribe and unsubscribe.
  let addPayload;
  let removePayload;
  let liveSnapshotAfterSubAdd;
  let payloadCountAfterAdd;
  let payloadCountAfterRemove;
  let payloadCountAfterUnsubscribe;

  before(() => {
    // Behavior 1: before any mutation the snapshot is empty, and each call
    // returns a fresh array rather than the internal reference.
    firstFresh = getToasts();
    secondFresh = getToasts();

    // Behavior 2: the first add returns id 1 and defaults the action fields to
    // null when no action is supplied.
    successId = toast.success('Saved!', { duration: 0 });
    afterSuccess = getToasts();

    // Behavior 3: the second add returns id 2 and keeps the passed-in action.
    errorId = toast.error('Boom', { duration: 0, action: actionFn, actionLabel: 'Undo' });
    afterError = getToasts();

    // Behavior 5: dismiss runs here (while only id 1 and id 2 exist) so the
    // result is exactly the id 2 survivor, before the subscribe block below adds
    // any further entries.
    toast.dismiss(1);
    afterDismiss = getToasts();

    // Behavior 4: a subscriber is notified with a fresh snapshot on both add and
    // remove, and stops receiving notifications once it unsubscribes.
    const payloads = [];
    const unsubscribe = subscribe((snapshot) => payloads.push(snapshot));

    toast.success('Subscribed add', { duration: 0 }); // id 3
    payloadCountAfterAdd = payloads.length;
    addPayload = payloads[0];
    liveSnapshotAfterSubAdd = getToasts();

    toast.dismiss(3);
    payloadCountAfterRemove = payloads.length;
    removePayload = payloads[1];

    unsubscribe();
    toast.success('After unsubscribe', { duration: 0 }); // id 4
    payloadCountAfterUnsubscribe = payloads.length;
  });

  it('starts empty and returns a fresh snapshot array on every call', () => {
    assert.deepStrictEqual(firstFresh, []);
    assert.deepStrictEqual(secondFresh, []);
    // A snapshot copy, not the internal reference, so two calls never alias.
    assert.notStrictEqual(firstFresh, secondFresh);
  });

  it('adds the first toast as id 1 with null action fields by default', () => {
    assert.strictEqual(successId, 1);
    assert.deepStrictEqual(afterSuccess, [
      { id: 1, type: 'success', message: 'Saved!', action: null, actionLabel: null },
    ]);
  });

  it('adds an action-bearing toast as id 2 and keeps the function reference', () => {
    assert.strictEqual(errorId, 2);
    assert.strictEqual(afterError.length, 2);
    assert.strictEqual(afterError[0].id, 1); // insertion order is preserved

    const entry = afterError[1];
    assert.strictEqual(entry.id, 2);
    assert.strictEqual(entry.type, 'error');
    assert.strictEqual(entry.message, 'Boom');
    assert.strictEqual(entry.actionLabel, 'Undo');
    // The same function reference is stored, not a copy.
    assert.strictEqual(entry.action, actionFn);
  });

  it('notifies subscribers with a fresh snapshot and stops after unsubscribe', () => {
    // Invoked once on add and once on remove, then never again.
    assert.strictEqual(payloadCountAfterAdd, 1);
    assert.strictEqual(payloadCountAfterRemove, 2);
    assert.strictEqual(payloadCountAfterUnsubscribe, 2);

    // The add payload is a fresh array (distinct reference) holding the live
    // state at notify time: the id 2 survivor plus the new id 3 entry.
    assert.ok(Array.isArray(addPayload));
    assert.notStrictEqual(addPayload, liveSnapshotAfterSubAdd);
    assert.deepStrictEqual(addPayload, liveSnapshotAfterSubAdd);
    assert.deepStrictEqual(addPayload.map((t) => t.id), [2, 3]);

    // The remove payload reflects the post-remove state.
    assert.deepStrictEqual(removePayload.map((t) => t.id), [2]);
  });

  it('dismisses only the matching id, leaving the rest', () => {
    assert.deepStrictEqual(afterDismiss, [
      { id: 2, type: 'error', message: 'Boom', action: actionFn, actionLabel: 'Undo' },
    ]);
  });
});
