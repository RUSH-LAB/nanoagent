#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Integration tests for new features: Glossary, Flashcards, Tasks, Streak, Snapshots, Schedule
// Usage:  node tests/integration/test-new-features.mjs
// Requires the server running on http://localhost:3001
// ─────────────────────────────────────────────────────────────

const BASE = process.env.API_URL || 'http://localhost:3001';

// ── Colors ──
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// ── State ──
let passed = 0;
let failed = 0;

function log(icon, color, label, detail = '') {
  const detailStr = detail ? ` ${DIM}${detail}${RESET}` : '';
  console.log(`  ${color}${icon}${RESET} ${label}${detailStr}`);
}

function pass(name, detail) {
  passed++;
  log('✓', GREEN, name, detail);
}

function fail(name, detail) {
  failed++;
  log('✗', RED, name, detail);
}

function section(title) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

// ── Helpers ──
async function api(method, path, body, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const init = {method, headers: {}};
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || body instanceof Buffer) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  if (opts.headers) Object.assign(init.headers, opts.headers);
  if (opts.signal) init.signal = opts.signal;
  const res = await fetch(url, init);
  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return {status: res.status, data, headers: res.headers};
}

function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertOk(cond, label) {
  if (!cond) throw new Error(label);
}

async function test(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (err) {
    fail(name, err.message);
  }
}

// ────────────────────────────────────────────────────────────────
// Connectivity check
// ────────────────────────────────────────────────────────────────

async function preflight() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(`${BASE}/api/health`, {signal: controller.signal});
    clearTimeout(timer);
    return true;
  } catch {
    console.error(`${RED}ERROR:${RESET} Cannot reach ${BASE}. Is the server running?`);
    console.error(`  Start it with:  node server/index.js`);
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────
// Unique test identifiers
// ────────────────────────────────────────────────────────────────

const TEST_PREFIX = `__test_${Date.now()}`;
const TEST_TERM = `test-term-${TEST_PREFIX}`;
const TEST_USER_ID = `test-user-${TEST_PREFIX}`;

// ────────────────────────────────────────────────────────────────
// Glossary (5 tests)
// ────────────────────────────────────────────────────────────────

let createdTermId = null;

async function testGlossary() {
  section('Glossary (5 tests)');

  // 1. Create term
  await test('POST /api/glossary — create term', async () => {
    const {status, data} = await api('POST', '/api/glossary', {
      term: TEST_TERM,
      definition: 'A test definition',
      relatedTerms: ['ML', 'AI'],
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.entry, 'has entry');
    assertOk(data.entry.id, 'has id');
    assertEq(data.entry.term, TEST_TERM, 'term matches');
    assertEq(data.entry.definition, 'A test definition', 'definition matches');
    assertOk(Array.isArray(data.entry.relatedTerms), 'relatedTerms is array');
    createdTermId = data.entry.id;
  });

  // 2. List terms — verify our term exists
  await test('GET /api/glossary — verify term exists', async () => {
    const {status, data} = await api('GET', '/api/glossary');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.terms), 'terms is array');
    assertOk(typeof data.total === 'number', 'has total count');
    const found = data.terms.find(t => t.term === TEST_TERM);
    assertOk(found, 'found our test term');
    assertEq(found.definition, 'A test definition', 'definition matches');
    assertEq(found.id, createdTermId, 'id matches');
  });

  // 3. Search terms via query param
  await test('GET /api/glossary?q=... — search term', async () => {
    const {status, data} = await api('GET', `/api/glossary?q=${encodeURIComponent(TEST_TERM)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.terms), 'terms is array');
    assertOk(data.terms.length >= 1, 'has at least one result');
    assertOk(data.terms.some(t => t.term === TEST_TERM), 'found our term in search');
  });

  // 4. Duplicate term is rejected (409)
  await test('POST /api/glossary — duplicate term rejected', async () => {
    const {status, data} = await api('POST', '/api/glossary', {
      term: TEST_TERM,
      definition: 'A duplicate definition',
    });
    assertEq(status, 409, 'status is 409 Conflict');
    assertOk(data.error, 'has error message');
  });

  // 5. Delete term
  await test('DELETE /api/glossary — remove term', async () => {
    const {status, data} = await api('DELETE', '/api/glossary', {id: createdTermId});
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', '/api/glossary');
    const found = listData.terms.find(t => t.id === createdTermId);
    assertOk(!found, 'term is gone');
    createdTermId = null;
  });
}

// ────────────────────────────────────────────────────────────────
// Flashcards (5 tests)
// ────────────────────────────────────────────────────────────────

let createdCardId = null;

async function testFlashcards() {
  section('Flashcards (5 tests)');

  // 1. Create flashcard
  await test('POST /api/flashcards — create card', async () => {
    const {status, data} = await api('POST', '/api/flashcards', {
      front: 'What is ML?',
      back: 'Machine Learning',
      tags: ['ml'],
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.card, 'has card');
    assertOk(data.card.id, 'has id');
    assertEq(data.card.front, 'What is ML?', 'front matches');
    assertEq(data.card.back, 'Machine Learning', 'back matches');
    assertOk(Array.isArray(data.card.tags), 'tags is array');
    assertOk(data.card.tags.includes('ml'), 'tag "ml" present');
    // SM-2 initial fields
    assertEq(data.card.interval, 1, 'initial interval');
    assertEq(data.card.easeFactor, 2.5, 'initial easeFactor');
    assertEq(data.card.repetitions, 0, 'initial repetitions');
    createdCardId = data.card.id;
  });

  // 2. List flashcards — verify card exists
  await test('GET /api/flashcards — verify card exists', async () => {
    const {status, data} = await api('GET', '/api/flashcards');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.cards), 'cards is array');
    assertOk(typeof data.total === 'number', 'has total');
    const found = data.cards.find(c => c.id === createdCardId);
    assertOk(found, 'found our card');
    assertEq(found.front, 'What is ML?', 'front matches');
  });

  // 3. Get cards due for review — check shape
  await test('GET /api/flashcards/due — check due cards shape', async () => {
    const {status, data} = await api('GET', '/api/flashcards/due');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.cards), 'cards is array');
    assertOk(typeof data.dueCount === 'number', 'has dueCount');
    // Our card should be due (nextReview was set to today)
    const found = data.cards.find(c => c.id === createdCardId);
    assertOk(found, 'our card is due for review');
  });

  // 4. Record review result (uses cardId, not id)
  await test('POST /api/flashcards/review — record review (quality=4)', async () => {
    const {status, data} = await api('POST', '/api/flashcards/review', {
      cardId: createdCardId,
      quality: 4,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.card, 'has card');
    assertEq(data.card.repetitions, 1, 'repetitions incremented');
    assertOk(data.card.lastReviewed !== null, 'lastReviewed set');
    assertOk(data.card.nextReview > new Date().toISOString().slice(0, 10), 'nextReview is in the future');
  });

  // 5. Delete flashcard (uses cardId, not id)
  await test('DELETE /api/flashcards — remove card', async () => {
    const {status, data} = await api('DELETE', '/api/flashcards', {cardId: createdCardId});
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', '/api/flashcards');
    const found = listData.cards.find(c => c.id === createdCardId);
    assertOk(!found, 'card is gone');
    createdCardId = null;
  });
}

// ────────────────────────────────────────────────────────────────
// Tasks (5 tests)
// ────────────────────────────────────────────────────────────────

let createdTaskId = null;

async function testTasks() {
  section('Tasks (5 tests)');

  // 1. Create task
  await test('POST /api/tasks — create task', async () => {
    const {status, data} = await api('POST', '/api/tasks', {
      title: 'Test task',
      status: 'todo',
      priority: 'high',
    });
    // Server returns 201 for task creation
    assertOk(status === 200 || status === 201, 'status is 200 or 201');
    assertOk(data.success, 'success');
    assertOk(data.task, 'has task');
    assertOk(data.task.id, 'has id');
    assertEq(data.task.title, 'Test task', 'title matches');
    assertEq(data.task.status, 'todo', 'status matches');
    assertEq(data.task.priority, 'high', 'priority matches');
    createdTaskId = data.task.id;
  });

  // 2. List tasks — verify grouped format
  await test('GET /api/tasks — verify task and grouped format', async () => {
    const {status, data} = await api('GET', '/api/tasks');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.tasks), 'tasks is array');
    assertOk(data.grouped, 'has grouped');
    assertOk(Array.isArray(data.grouped.todo), 'grouped.todo is array');
    assertOk(Array.isArray(data.grouped.doing), 'grouped.doing is array');
    assertOk(Array.isArray(data.grouped.done), 'grouped.done is array');
    assertOk(data.counts, 'has counts');
    assertOk(typeof data.counts.todo === 'number', 'counts.todo is number');
    const found = data.tasks.find(t => t.id === createdTaskId);
    assertOk(found, 'found our task');
    assertEq(found.status, 'todo', 'task is in todo');
    // Should also be in grouped.todo
    assertOk(data.grouped.todo.some(t => t.id === createdTaskId), 'task in grouped.todo');
  });

  // 3. Update task status
  await test('PUT /api/tasks — mark as done', async () => {
    const {status, data} = await api('PUT', '/api/tasks', {
      id: createdTaskId,
      status: 'done',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertEq(data.task.status, 'done', 'status updated to done');
  });

  // 4. List tasks — verify status changed
  await test('GET /api/tasks — verify status changed to done', async () => {
    const {status, data} = await api('GET', '/api/tasks');
    assertEq(status, 200, 'status');
    const found = data.tasks.find(t => t.id === createdTaskId);
    assertOk(found, 'found our task');
    assertEq(found.status, 'done', 'status is now done');
    assertOk(data.grouped.done.some(t => t.id === createdTaskId), 'task in grouped.done');
    assertOk(!data.grouped.todo.some(t => t.id === createdTaskId), 'task not in grouped.todo');
  });

  // 5. Delete task
  await test('DELETE /api/tasks — remove task', async () => {
    const {status, data} = await api('DELETE', '/api/tasks', {id: createdTaskId});
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', '/api/tasks');
    const found = listData.tasks.find(t => t.id === createdTaskId);
    assertOk(!found, 'task is gone');
    createdTaskId = null;
  });
}

// ────────────────────────────────────────────────────────────────
// Streak (3 tests)
// ────────────────────────────────────────────────────────────────

const TEST_STREAK_USER = `test-streak-${TEST_PREFIX}`;

async function testStreak() {
  section('Streak (3 tests)');

  // 1. Log words written
  await test('POST /api/streak — log words written', async () => {
    const {status, data} = await api('POST', '/api/streak', {
      wordsWritten: 200,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertEq(data.words, 200, 'words echoed back');
    assertOk(data.date, 'has date');
  });

  // 2. Retrieve streak data
  await test('GET /api/streak — verify streak data shape', async () => {
    const {status, data} = await api('GET', `/api/streak`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.currentStreak === 'number', 'has currentStreak');
    assertOk(typeof data.longestStreak === 'number', 'has longestStreak');
    assertOk(typeof data.totalWords === 'number', 'has totalWords');
    assertOk(Array.isArray(data.dailyLog), 'dailyLog is array');
    assertOk(data.dailyLog.length >= 1, 'dailyLog has at least one entry');
    assertEq(data.totalWords, 200, 'totalWords equals 200');
    // 200 words >= 50 threshold, so streak should be at least 1
    assertOk(data.currentStreak >= 1, 'currentStreak is at least 1');
  });

  // 3. Post again with more words — verify update
  await test('POST /api/streak — update with more words', async () => {
    const {status, data} = await api('POST', '/api/streak', {
      wordsWritten: 500,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertEq(data.words, 500, 'words updated to 500');
    // Verify via GET that the daily entry was updated (replaced, not appended)
    const {data: streakData} = await api('GET', `/api/streak`);
    assertEq(streakData.totalWords, 500, 'totalWords reflects updated value');
    assertEq(streakData.dailyLog.length, 1, 'still only one daily entry (replaced, not appended)');
  });
}

// ────────────────────────────────────────────────────────────────
// Snapshots (5 tests — includes setup + cleanup)
// ────────────────────────────────────────────────────────────────

const TEST_SNAPSHOT_PATH = `content/__test_snapshot_${Date.now()}.md`;
let createdSnapshotId = null;

async function testSnapshots() {
  section('Snapshots (5 tests)');

  // Setup: create a test file via the file-create API
  await test('Setup — create test file for snapshots', async () => {
    const {status, data} = await api('POST', '/api/file', {
      path: TEST_SNAPSHOT_PATH,
      content: '# Snapshot Test\n\nThis is a test file for snapshot tests.',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'file created');
  });

  // 1. Create a snapshot
  await test('POST /api/snapshots — create snapshot', async () => {
    const {status, data} = await api('POST', '/api/snapshots', {
      path: TEST_SNAPSHOT_PATH,
      name: 'test snapshot',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.snapshot, 'has snapshot');
    assertOk(data.snapshot.id, 'has id');
    assertEq(data.snapshot.name, 'test snapshot', 'name matches');
    assertOk(data.snapshot.createdAt, 'has createdAt');
    createdSnapshotId = data.snapshot.id;
  });

  // 2. List snapshots for the file
  await test('GET /api/snapshots?path=... — list snapshots', async () => {
    const {status, data} = await api('GET', `/api/snapshots?path=${encodeURIComponent(TEST_SNAPSHOT_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.snapshots), 'snapshots is array');
    assertOk(data.snapshots.length >= 1, 'has at least one snapshot');
    const found = data.snapshots.find(s => s.id === createdSnapshotId);
    assertOk(found, 'found our snapshot');
    assertEq(found.name, 'test snapshot', 'name matches');
    assertOk(found.createdAt, 'has createdAt');
  });

  // 3. Delete the snapshot
  await test('DELETE /api/snapshots — remove snapshot', async () => {
    const {status, data} = await api('DELETE', '/api/snapshots', {
      path: TEST_SNAPSHOT_PATH,
      snapshotId: createdSnapshotId,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', `/api/snapshots?path=${encodeURIComponent(TEST_SNAPSHOT_PATH)}`);
    const found = listData.snapshots.find(s => s.id === createdSnapshotId);
    assertOk(!found, 'snapshot is gone');
    createdSnapshotId = null;
  });

  // 4. Cleanup: delete the test file
  await test('Cleanup — remove test file', async () => {
    const {status} = await api('DELETE', `/api/file?path=${encodeURIComponent(TEST_SNAPSHOT_PATH)}`);
    assertEq(status, 200, 'status');
  });
}

// ────────────────────────────────────────────────────────────────
// Schedule (3 tests)
// ────────────────────────────────────────────────────────────────

const SCHEDULE_TEST_PATH = 'content/books/math/0-intro.md';
let createdScheduleId = null;

async function testSchedule() {
  section('Schedule (3 tests)');

  const futureDate = new Date(Date.now() + 7 * 86400000).toISOString();

  // 1. Create a schedule entry
  await test('POST /api/schedule — schedule a file for future publish', async () => {
    const {status, data} = await api('POST', '/api/schedule', {
      path: SCHEDULE_TEST_PATH,
      publishAt: futureDate,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.item, 'has item');
    assertOk(data.item.id, 'has id');
    assertEq(data.item.path, SCHEDULE_TEST_PATH, 'path matches');
    assertOk(data.item.publishAt, 'has publishAt');
    assertEq(data.item.status, 'scheduled', 'status is scheduled');
    assertOk(data.item.createdAt, 'has createdAt');
    createdScheduleId = data.item.id;
  });

  // 2. List schedules — verify our entry exists
  await test('GET /api/schedule — verify schedule exists', async () => {
    const {status, data} = await api('GET', '/api/schedule');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.items), 'items is array');
    assertOk(typeof data.upcoming === 'number', 'has upcoming count');
    assertOk(typeof data.due === 'number', 'has due count');
    const found = data.items.find(i => i.id === createdScheduleId);
    assertOk(found, 'found our scheduled entry');
    assertEq(found.path, SCHEDULE_TEST_PATH, 'path matches');
    assertEq(found.status, 'scheduled', 'status is scheduled');
  });

  // 3. Delete the schedule entry
  await test('DELETE /api/schedule — remove scheduled entry', async () => {
    const {status, data} = await api('DELETE', '/api/schedule', {id: createdScheduleId});
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', '/api/schedule');
    const found = listData.items.find(i => i.id === createdScheduleId);
    assertOk(!found, 'schedule entry is gone');
    createdScheduleId = null;
  });
}

// ────────────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────────────

async function runCleanup() {
  section('Cleanup');
  let cleaned = 0;

  // Clean up any leftover test data

  // Glossary: try to delete test term by id (may already be gone)
  if (createdTermId) {
    try {
      await api('DELETE', '/api/glossary', {id: createdTermId});
      cleaned++;
    } catch { /* ignore */ }
  }

  // Flashcards: try to delete test card if it still exists
  if (createdCardId) {
    try {
      await api('DELETE', '/api/flashcards', {cardId: createdCardId});
      cleaned++;
    } catch { /* ignore */ }
  }

  // Tasks: try to delete test task if it still exists
  if (createdTaskId) {
    try {
      await api('DELETE', '/api/tasks', {id: createdTaskId});
      cleaned++;
    } catch { /* ignore */ }
  }

  // Snapshots: try to delete leftover snapshot
  if (createdSnapshotId) {
    try {
      await api('DELETE', '/api/snapshots', {path: TEST_SNAPSHOT_PATH, snapshotId: createdSnapshotId});
      cleaned++;
    } catch { /* ignore */ }
  }

  // Schedule: try to delete leftover schedule entry
  if (createdScheduleId) {
    try {
      await api('DELETE', '/api/schedule', {id: createdScheduleId});
      cleaned++;
    } catch { /* ignore */ }
  }

  log('✓', GREEN, `${cleaned} cleanup actions completed`);
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}Mochi Lab — New Features Integration Tests${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}`);
  console.log(`${DIM}Testing: Glossary, Flashcards, Tasks, Streak, Snapshots, Schedule (26 tests)${RESET}\n`);

  await preflight();

  await testGlossary();
  await testFlashcards();
  await testTasks();
  await testStreak();
  await testSnapshots();
  await testSchedule();

  await runCleanup();

  // ── Summary ──
  const total = passed + failed;
  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  ${GREEN}${passed}${RESET} passed, ${failed > 0 ? RED : ''}${failed}${RESET} failed`);
  console.log(`  ${passed}/${total} tests passed\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${RED}Unhandled error:${RESET}`, err);
  process.exit(2);
});
