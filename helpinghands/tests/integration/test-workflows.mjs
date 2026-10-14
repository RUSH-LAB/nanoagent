#!/usr/bin/env node
import {createApiClient} from './api-client.mjs';
// ─────────────────────────────────────────────────────────────
// End-to-end user workflow tests for Mochi Lab
// Tests 3 complete user journeys (12 tests total)
// Usage:  node tests/integration/test-workflows.mjs
// Requires the server running on http://localhost:3001, and a GitHub sign-in
// saved by `node cli/rush.mjs login http://localhost:3001`
// ─────────────────────────────────────────────────────────────

const BASE = process.env.API_URL || 'http://localhost:3001';

// ── Colors ──
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

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
  console.log(`\n${BOLD}${CYAN}${title}${RESET}`);
}

function step(n, label) {
  console.log(`  ${DIM}Step ${n}:${RESET} ${label}`);
}

// ── Helpers ──
const api = createApiClient(BASE);

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

const TS = Date.now();
const TEST_PREFIX = `wftest-${TS}`;

// ════════════════════════════════════════════════════════════════
// Journey 1: Researcher writes and publishes (6 steps)
// ════════════════════════════════════════════════════════════════

async function journey1() {
  section('Journey 1: Researcher writes and publishes');

  const filePath = `content/posts/${TEST_PREFIX}_research_post.md`;
  const initialContent = `---\ntitle: "Workflow Test Post"\ndate: 2025-06-01\n---\n\n# Introduction\n\nThis is a placeholder.\n`;
  const richContent = `---\ntitle: "Workflow Test Post"\ndate: 2025-06-01\n---\n\n# Introduction\n\nThis is a comprehensive research article about machine learning fundamentals. The field of machine learning has grown enormously over the past decade. We explore the key concepts that underpin modern approaches to artificial intelligence and deep learning systems.\n\n## Background\n\nMachine learning is a subfield of artificial intelligence that focuses on building systems that learn from data. Traditional programming requires explicit instructions, while machine learning allows systems to discover patterns and make decisions based on experience. This paradigm shift has led to breakthroughs in computer vision, natural language processing, and reinforcement learning.\n\n## Methods\n\nWe survey the most common approaches including supervised learning, unsupervised learning, and reinforcement learning. Each methodology has distinct advantages depending on the problem domain and available data. Supervised learning uses labeled datasets, unsupervised learning discovers hidden structures, and reinforcement learning optimizes through trial and error.\n\n### Supervised Learning\n\nSupervised learning trains models on labeled input-output pairs. Common algorithms include linear regression, decision trees, support vector machines, and neural networks. The choice of algorithm depends on the nature of the data and the complexity of the underlying relationship.\n\n### Unsupervised Learning\n\nUnsupervised learning finds patterns in unlabeled data. Clustering and dimensionality reduction are the two main categories. K-means clustering, hierarchical clustering, and principal component analysis are widely used techniques in this domain.\n\n## Results\n\nOur analysis shows significant improvements across all benchmarks when combining multiple learning paradigms. The hybrid approach achieves state-of-the-art performance on several standard evaluation metrics, demonstrating the value of methodological diversity.\n\n## Conclusion\n\nMachine learning continues to evolve rapidly and promises further advances in the coming years. We recommend that practitioners stay current with the latest developments and consider hybrid approaches for complex real-world problems.\n`;
  const refKey = `${TEST_PREFIX}_ref`;
  let snapshotId = null;

  // Step 1: Create a new blog post
  step(1, 'Create a new blog post');
  await test('1.1 Create blog post via document API', async () => {
    const {status, data} = await api('POST', '/api/documents', {
      path: filePath,
      markdown: initialContent,
    });
    assertEq(status, 201, 'status');
    assertOk(data.success, 'file created');
  });

  // Step 2: Add rich content
  step(2, 'Add rich content');
  await test('1.2 Update content via document API', async () => {
    const {status, data} = await api('PUT', '/api/documents', {
      path: filePath,
      markdown: richContent,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'content updated');
    // Verify updated content
    const {data: readData} = await api('GET', `/api/documents/source?path=${encodeURIComponent(filePath)}`);
    assertOk(readData.markdown.includes('machine learning fundamentals'), 'rich content saved');
  });

  // Step 3: Check quality score
  step(3, 'Check quality score');
  await test('1.3 Check quality via GET /api/documents/analysis/quality', async () => {
    const {status, data} = await api('GET', `/api/documents/analysis/quality?path=${encodeURIComponent(filePath)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.score === 'number', 'has numeric score');
    assertOk(data.score > 0, 'score is positive');
    assertOk(data.score <= 100, 'score is <= 100');
    assertOk(Array.isArray(data.suggestions), 'has suggestions array');
    assertOk(typeof data.breakdown === 'object', 'has breakdown object');
  });

  // Step 4: Add a reference
  step(4, 'Add a reference');
  await test('1.4 Add reference via POST /api/references', async () => {
    const {status, data} = await api('POST', '/api/references', {
      key: refKey,
      entry: {
        type: 'article',
        title: 'Workflow Test Reference Paper',
        author: ['Test Author', 'Second Author'],
        year: 2025,
        venue: 'Test Conference',
      },
    });
    assertOk(status === 200 || status === 201, 'status 200 or 201');
    assertOk(data.success, 'reference added');
  });

  // Step 5: Create a snapshot
  step(5, 'Create a snapshot');
  await test('1.5 Create snapshot via POST /api/snapshots', async () => {
    const {status, data} = await api('POST', '/api/snapshots', {
      path: filePath,
      name: 'pre-publish snapshot',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'snapshot created');
    assertOk(data.snapshot, 'has snapshot object');
    assertOk(data.snapshot.id, 'snapshot has id');
    assertEq(data.snapshot.name, 'pre-publish snapshot', 'snapshot name matches');
    snapshotId = data.snapshot.id;
  });

  // Step 6: Verify it appears in RSS feed
  step(6, 'Verify post in RSS feed');
  await test('1.6 Post appears in GET /api/feed/rss', async () => {
    const {status, data} = await api('GET', '/api/feed/rss');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'RSS is text');
    assertOk(data.includes('<rss'), 'valid RSS');
    assertOk(data.includes('Workflow Test Post'), 'post title appears in RSS feed');
  });

  // Cleanup
  console.log(`  ${DIM}Cleaning up Journey 1 test data...${RESET}`);
  let cleanCount = 0;
  let cleanErrors = 0;

  // Delete the snapshot
  if (snapshotId) {
    try {
      await api('DELETE', '/api/snapshots', {path: filePath, snapshotId});
      cleanCount++;
    } catch { cleanErrors++; }
  }

  // Delete the test file
  try {
    await api('DELETE', '/api/documents', {path: filePath});
    cleanCount++;
  } catch { cleanErrors++; }

  try {
    await api('DELETE', `/api/references/${encodeURIComponent(refKey)}`);
    cleanCount++;
  } catch { cleanErrors++; }

  if (cleanErrors > 0) {
    log('!', YELLOW, `Journey 1 cleanup: ${cleanCount} ok, ${cleanErrors} errors`);
  } else {
    log('✓', GREEN, `Journey 1 cleanup: ${cleanCount} items cleaned`);
  }
}

// ════════════════════════════════════════════════════════════════
// Journey 2: Collaboration (6 steps)
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// Journey 3: Study session (4 steps)
// ════════════════════════════════════════════════════════════════

async function journey3() {
  section('Journey 3: Study session');

  const studyUserId = `${TEST_PREFIX}_student`;
  let cardId = null;

  // Step 1: Create a flashcard
  step(1, 'Create a flashcard');
  await test('3.1 Create flashcard via POST /api/flashcards', async () => {
    const {status, data} = await api('POST', '/api/flashcards', {
      front: 'What is the Transformer architecture?',
      back: 'A neural network architecture based on self-attention mechanisms, introduced in "Attention Is All You Need" (2017).',
      tags: ['deep-learning', 'nlp'],
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'card created');
    assertOk(data.card, 'has card');
    assertOk(data.card.id, 'card has id');
    assertEq(data.card.front, 'What is the Transformer architecture?', 'front matches');
    assertEq(data.card.interval, 1, 'initial interval is 1');
    assertEq(data.card.repetitions, 0, 'initial repetitions is 0');
    cardId = data.card.id;
  });

  // Step 2: Get due cards
  step(2, 'Get due cards for review');
  await test('3.2 Get due cards via GET /api/flashcards/due', async () => {
    const {status, data} = await api('GET', `/api/flashcards/due`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.cards), 'cards is array');
    assertOk(typeof data.dueCount === 'number', 'has dueCount');
    // Our new card should be due (nextReview was set to today)
    const found = data.cards.find(c => c.id === cardId);
    assertOk(found, 'our card is due for review');
  });

  // Step 3: Review the card
  step(3, 'Review the card (quality=4, good recall)');
  await test('3.3 Review card via POST /api/flashcards/review', async () => {
    assertOk(cardId, 'card id from step 1');
    const {status, data} = await api('POST', '/api/flashcards/review', {
      cardId,
      quality: 4,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'review recorded');
    assertOk(data.card, 'has updated card');
    assertEq(data.card.repetitions, 1, 'repetitions incremented to 1');
    assertOk(data.card.lastReviewed !== null, 'lastReviewed is set');
    assertOk(data.card.nextReview > new Date().toISOString().slice(0, 10), 'nextReview is in the future');
  });

  // Step 4: Track writing streak
  step(4, 'Track writing streak');
  await test('3.4 Log streak via POST /api/streak', async () => {
    const {status, data} = await api('POST', '/api/streak', {
      wordsWritten: 350,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'streak logged');
    assertEq(data.words, 350, 'words echoed back');
    assertOk(typeof data.date === 'string', 'has date');

    // Verify streak data
    const {data: streakData} = await api('GET', `/api/streak`);
    assertEq(streakData.totalWords, 350, 'totalWords is 350');
    assertOk(streakData.currentStreak >= 1, 'currentStreak is at least 1');
    assertOk(Array.isArray(streakData.dailyLog), 'has dailyLog');
    assertEq(streakData.dailyLog.length, 1, 'one daily entry');
  });

  // Cleanup
  console.log(`  ${DIM}Cleaning up Journey 3 test data...${RESET}`);
  let cleanCount = 0;
  let cleanErrors = 0;

  // Delete the flashcard
  if (cardId) {
    try {
      await api('DELETE', '/api/flashcards', {cardId});
      cleanCount++;
    } catch { cleanErrors++; }
  }

  // Streak data is a per-day word count under the caller's own key, so it is
  // harmless and needs no cleanup.

  if (cleanErrors > 0) {
    log('!', YELLOW, `Journey 3 cleanup: ${cleanCount} ok, ${cleanErrors} errors`);
  } else {
    log('✓', GREEN, `Journey 3 cleanup: ${cleanCount} items cleaned`);
  }
}

// ════════════════════════════════════════════════════════════════
// Journey 4: Data management (2 steps)
// ════════════════════════════════════════════════════════════════

async function journey4() {
  section('Journey 4: Data management');

  const fileA = `content/posts/${TEST_PREFIX}_data_a.md`;
  const snapshotFile = `content/posts/${TEST_PREFIX}_snap_target.md`;
  const scheduleFile = `content/posts/${TEST_PREFIX}_sched_target.md`;

  const contentTemplate = (title) =>
    `---\ntitle: "${title}"\ndate: 2025-07-01\ndraft: true\n---\n\nBody of ${title}.\n`;

  let snapshotId = null;
  let scheduleEntry = null;

  // ── Seed files needed by multiple steps ──
  console.log(`  ${DIM}Seeding test files...${RESET}`);
  for (const [fp, title] of [
    [fileA, 'Data A'],
    [snapshotFile, 'Snapshot Target'],
    [scheduleFile, 'Schedule Target'],
  ]) {
    await api('POST', '/api/documents', {path: fp, markdown: contentTemplate(title)});
  }

  // Step 1: Snapshot restore
  step(1, 'Create a snapshot, modify the file, then restore');
  await test('4.1 Snapshot restore via POST /api/snapshots/restore', async () => {
    // Take a snapshot of the original content
    const {status: snapStatus, data: snapData} = await api('POST', '/api/snapshots', {
      path: snapshotFile,
      name: 'before-edit',
    });
    assertEq(snapStatus, 200, 'snapshot created');
    assertOk(snapData.snapshot && snapData.snapshot.id, 'snapshot has id');
    snapshotId = snapData.snapshot.id;

    // Modify the file so it differs from the snapshot
    const modifiedContent = contentTemplate('Snapshot Target') + '\nExtra paragraph added after snapshot.\n';
    const {status: updateStatus} = await api('PUT', '/api/documents', {
      path: snapshotFile,
      markdown: modifiedContent,
    });
    assertEq(updateStatus, 200, 'file updated');

    // Verify the file was modified
    const {data: preRestore} = await api('GET', `/api/documents/source?path=${encodeURIComponent(snapshotFile)}`);
    assertOk(preRestore.markdown.includes('Extra paragraph'), 'file has modified content before restore');

    // Restore the snapshot
    const {status: restoreStatus, data: restoreData} = await api('POST', '/api/snapshots/restore', {
      path: snapshotFile,
      snapshotId,
    });
    assertEq(restoreStatus, 200, 'restore status');
    assertOk(restoreData.success, 'restore succeeded');
    assertEq(restoreData.restored.id, snapshotId, 'restored snapshot id matches');
    assertEq(restoreData.restored.name, 'before-edit', 'restored snapshot name matches');

    // Verify the file content is back to the original
    const {data: postRestore} = await api('GET', `/api/documents/source?path=${encodeURIComponent(snapshotFile)}`);
    assertOk(!postRestore.markdown.includes('Extra paragraph'), 'modified content removed after restore');
    assertOk(postRestore.markdown.includes('Body of Snapshot Target'), 'original content restored');
  });

  // Step 2: Scheduled publish checker
  step(2, 'Schedule a post for publication and verify status');
  await test('4.2 Scheduled publish via POST/GET /api/schedule', async () => {
    // Schedule a file for a date in the past so the checker marks it as due
    const pastDate = new Date(Date.now() - 60000).toISOString();
    const {status: schedStatus, data: schedData} = await api('POST', '/api/schedule', {
      path: scheduleFile,
      publishAt: pastDate,
    });
    assertEq(schedStatus, 200, 'schedule status');
    assertOk(schedData.success, 'schedule created');
    assertOk(schedData.schedule || schedData.item, 'has schedule entry');
    scheduleEntry = schedData.schedule || schedData.item;

    // GET /api/schedule should list our entry; since publishAt is in the past
    // the checker on GET marks it as 'due'
    const {status: listStatus, data: listData} = await api('GET', '/api/schedule');
    assertEq(listStatus, 200, 'list status');

    // The response may use either {schedules} or {items} depending on which
    // handler processes the request; handle both shapes.
    const items = listData.schedules || listData.items || [];
    assertOk(Array.isArray(items), 'has items array');
    const ours = items.find(i => i.path === scheduleFile);
    assertOk(ours, 'our scheduled item is present');

    // If the response includes due/upcoming counts, verify at least 1 due
    if (typeof listData.due === 'number') {
      assertOk(listData.due >= 1, 'at least 1 due item');
    }
  });

  // Cleanup
  console.log(`  ${DIM}Cleaning up Journey 4 test data...${RESET}`);
  let cleanCount = 0;
  let cleanErrors = 0;

  // Delete snapshot
  if (snapshotId) {
    try {
      await api('DELETE', '/api/snapshots', {path: snapshotFile, snapshotId});
      cleanCount++;
    } catch { cleanErrors++; }
  }

  // Delete schedule entry
  if (scheduleEntry) {
    try {
      const deleteKey = scheduleEntry.id ? {id: scheduleEntry.id} : {path: scheduleFile};
      await api('DELETE', '/api/schedule', deleteKey);
      cleanCount++;
    } catch { cleanErrors++; }
  }

  // Remove seeded/restored files
  for (const fp of [fileA, snapshotFile, scheduleFile]) {
    try {
      await api('DELETE', '/api/documents', {path: fp});
      cleanCount++;
    } catch { cleanErrors++; }
  }

  if (cleanErrors > 0) {
    log('!', YELLOW, `Journey 4 cleanup: ${cleanCount} ok, ${cleanErrors} errors`);
  } else {
    log('✓', GREEN, `Journey 4 cleanup: ${cleanCount} items cleaned`);
  }
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}Mochi Lab — End-to-End Workflow Tests${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}`);
  console.log(`${DIM}Testing 3 user journeys (12 tests)${RESET}`);

  await preflight();

  await journey1();
  await journey3();
  await journey4();

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
