#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// End-to-end user workflow tests for Mochi Lab
// Tests 3 complete user journeys (~19 tests total)
// Usage:  node scripts/test-workflows.mjs
// Requires the server running on http://localhost:3001
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
    console.error(`  Start it with:  node server.js`);
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────
// Unique test identifiers
// ────────────────────────────────────────────────────────────────

const TS = Date.now();
const TEST_PREFIX = `wftest-${TS}`;

// ════════════════════════════════════════════════════════════════
// Journey 1: Researcher writes and publishes (8 steps)
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
  await test('1.1 Create blog post via POST /api/file', async () => {
    const {status, data} = await api('POST', '/api/file', {
      path: filePath,
      content: initialContent,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'file created');
  });

  // Step 2: Set it as draft
  step(2, 'Set post as draft');
  await test('1.2 Mark as draft via POST /api/file/draft', async () => {
    const {status, data} = await api('POST', '/api/file/draft', {
      path: filePath,
      draft: true,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'draft set');
    // Verify draft is set
    const {data: info} = await api('GET', `/api/file/info?path=${encodeURIComponent(filePath)}`);
    assertEq(info.draft, true, 'draft confirmed in file info');
  });

  // Step 3: Add rich content
  step(3, 'Add rich content');
  await test('1.3 Update content via PUT /api/file', async () => {
    const {status, data} = await api('PUT', '/api/file', {
      path: filePath,
      content: richContent,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'content updated');
    // Verify updated content
    const {data: readData} = await api('GET', `/api/file?path=${encodeURIComponent(filePath)}`);
    assertOk(readData.content.includes('machine learning fundamentals'), 'rich content saved');
  });

  // Step 4: Check quality score
  step(4, 'Check quality score');
  await test('1.4 Check quality via GET /api/file/quality', async () => {
    const {status, data} = await api('GET', `/api/file/quality?path=${encodeURIComponent(filePath)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.score === 'number', 'has numeric score');
    assertOk(data.score > 0, 'score is positive');
    assertOk(data.score <= 100, 'score is <= 100');
    assertOk(Array.isArray(data.suggestions), 'has suggestions array');
    assertOk(typeof data.breakdown === 'object', 'has breakdown object');
  });

  // Step 5: Add a reference
  step(5, 'Add a reference');
  await test('1.5 Add reference via POST /api/references', async () => {
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

  // Step 6: Create a snapshot
  step(6, 'Create a snapshot');
  await test('1.6 Create snapshot via POST /api/snapshots', async () => {
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

  // Step 7: Publish (undraft)
  step(7, 'Publish the post');
  await test('1.7 Publish (undraft) via POST /api/file/draft', async () => {
    const {status, data} = await api('POST', '/api/file/draft', {
      path: filePath,
      draft: false,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'published');
    // Verify draft is removed
    const {data: info} = await api('GET', `/api/file/info?path=${encodeURIComponent(filePath)}`);
    assertEq(info.draft, false, 'draft is false after publish');
  });

  // Step 8: Verify it appears in RSS feed
  step(8, 'Verify post in RSS feed');
  await test('1.8 Post appears in GET /api/feed/rss', async () => {
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
    await api('DELETE', `/api/file?path=${encodeURIComponent(filePath)}`);
    cleanCount++;
  } catch { cleanErrors++; }

  // Note: references don't have a DELETE endpoint, but the key is unique
  // and harmless. We leave it to avoid complicating cleanup.

  if (cleanErrors > 0) {
    log('!', YELLOW, `Journey 1 cleanup: ${cleanCount} ok, ${cleanErrors} errors`);
  } else {
    log('✓', GREEN, `Journey 1 cleanup: ${cleanCount} items cleaned`);
  }
}

// ════════════════════════════════════════════════════════════════
// Journey 2: Collaboration (6 steps)
// ════════════════════════════════════════════════════════════════

async function journey2() {
  section('Journey 2: Collaboration');

  const channelName = `Workflow Test ${TEST_PREFIX}`;
  const commentPage = `${TEST_PREFIX}/collab-page`;
  let channelId = null;
  let messageId = null;
  let commentId = null;
  const userId = `${TEST_PREFIX}_collaborator`;

  // Step 1: Create a discussion channel
  step(1, 'Create a discussion channel');
  await test('2.1 Create channel via POST /api/discussions', async () => {
    const {status, data} = await api('POST', '/api/discussions', {
      name: channelName,
      topic: 'Discussing our research workflow',
    });
    assertOk(status === 200 || status === 201, 'status 200 or 201');
    assertOk(data.channel, 'has channel');
    assertOk(data.channel.id, 'channel has id');
    assertEq(data.channel.name, channelName, 'name matches');
    channelId = data.channel.id;
  });

  // Step 2: Post a message
  step(2, 'Post a message to the channel');
  await test('2.2 Post message via POST /api/discussions/:id/messages', async () => {
    assertOk(channelId, 'channel id from step 1');
    const {status, data} = await api('POST', `/api/discussions/${channelId}/messages`, {
      author: 'Researcher A',
      text: 'I found an interesting paper we should discuss!',
    });
    assertOk(status === 200 || status === 201, 'status 200 or 201');
    assertOk(data.message, 'has message');
    assertOk(data.message.id, 'message has id');
    assertEq(data.message.text, 'I found an interesting paper we should discuss!', 'text matches');
    messageId = data.message.id;
  });

  // Step 3: Pin the message
  step(3, 'Pin the important message');
  await test('2.3 Pin message via POST /api/discussions/:id/pin', async () => {
    assertOk(channelId && messageId, 'channel and message ids from prior steps');
    const {status, data} = await api('POST', `/api/discussions/${channelId}/pin`, {
      messageId,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'message pinned');
  });

  // Step 4: Add a comment on a page
  step(4, 'Add a comment on a page');
  await test('2.4 Add comment via POST /api/comments', async () => {
    const {status, data} = await api('POST', '/api/comments', {
      page: commentPage,
      author: 'Reviewer B',
      text: 'Great analysis in section 3!',
    });
    assertEq(status, 200, 'status');
    assertOk(data.comment, 'has comment');
    assertOk(data.comment.id, 'comment has id');
    commentId = data.comment.id;
  });

  // Step 5: React to the comment
  step(5, 'React to the comment');
  await test('2.5 React via POST /api/comments/react', async () => {
    assertOk(commentId, 'comment id from step 4');
    const {status, data} = await api('POST', '/api/comments/react', {
      page: commentPage,
      commentId,
      emoji: 'thumbsup',
      userId,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'reaction added');
    assertOk(Array.isArray(data.reactions), 'has reactions array');
    const reaction = data.reactions.find(r => r.emoji === 'thumbsup' && r.userId === userId);
    assertOk(reaction, 'our reaction is present');
  });

  // Step 6: Check notifications
  step(6, 'Check notification counts');
  await test('2.6 Check notifications via GET /api/notifications/counts', async () => {
    // Use a since timestamp from just before we started so we capture our test data
    const since = new Date(TS - 5000).toISOString();
    const {status, data} = await api('GET', `/api/notifications/counts?since=${encodeURIComponent(since)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.comments === 'number', 'has comments count');
    assertOk(typeof data.discussions === 'number', 'has discussions count');
    // Our comment and message should be counted
    assertOk(data.comments >= 1, 'at least 1 new comment notification');
    assertOk(data.discussions >= 1, 'at least 1 new discussion notification');
  });

  // Cleanup
  console.log(`  ${DIM}Cleaning up Journey 2 test data...${RESET}`);
  let cleanCount = 0;
  let cleanErrors = 0;

  // Delete the comment
  if (commentId) {
    try {
      await api('DELETE', '/api/comments', {page: commentPage, commentId});
      cleanCount++;
    } catch { cleanErrors++; }
  }

  // Delete the discussion channel (also removes messages and pins)
  if (channelId) {
    try {
      await api('DELETE', `/api/discussions/${channelId}`);
      cleanCount++;
    } catch { cleanErrors++; }
  }

  if (cleanErrors > 0) {
    log('!', YELLOW, `Journey 2 cleanup: ${cleanCount} ok, ${cleanErrors} errors`);
  } else {
    log('✓', GREEN, `Journey 2 cleanup: ${cleanCount} items cleaned`);
  }
}

// ════════════════════════════════════════════════════════════════
// Journey 3: Study session (5 steps)
// ════════════════════════════════════════════════════════════════

async function journey3() {
  section('Journey 3: Study session');

  const studyUserId = `${TEST_PREFIX}_student`;
  let cardId = null;
  let goalId = null;

  // Step 1: Create a flashcard
  step(1, 'Create a flashcard');
  await test('3.1 Create flashcard via POST /api/flashcards', async () => {
    const {status, data} = await api('POST', '/api/flashcards', {
      userId: studyUserId,
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
    const {status, data} = await api('GET', `/api/flashcards/due?userId=${encodeURIComponent(studyUserId)}`);
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
      userId: studyUserId,
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
      userId: studyUserId,
      wordsWritten: 350,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'streak logged');
    assertEq(data.words, 350, 'words echoed back');
    assertOk(typeof data.date === 'string', 'has date');

    // Verify streak data
    const {data: streakData} = await api('GET', `/api/streak?userId=${encodeURIComponent(studyUserId)}`);
    assertEq(streakData.totalWords, 350, 'totalWords is 350');
    assertOk(streakData.currentStreak >= 1, 'currentStreak is at least 1');
    assertOk(Array.isArray(streakData.dailyLog), 'has dailyLog');
    assertEq(streakData.dailyLog.length, 1, 'one daily entry');
  });

  // Step 5: Check goals
  step(5, 'Create and check a writing goal');
  await test('3.5 Create and verify goal via POST/GET /api/goals', async () => {
    // Create a daily goal
    const {status: createStatus, data: createData} = await api('POST', '/api/goals', {
      type: 'daily',
      target: 500,
      userId: studyUserId,
    });
    assertOk(createStatus === 200 || createStatus === 201, 'goal created');
    assertOk(createData.id, 'goal has id');
    assertEq(createData.type, 'daily', 'type is daily');
    assertEq(createData.target, 500, 'target is 500');
    goalId = createData.id;

    // Verify the goal shows up with progress data
    const {status: getStatus, data: getData} = await api('GET', `/api/goals?userId=${encodeURIComponent(studyUserId)}`);
    assertEq(getStatus, 200, 'get status');
    assertOk(Array.isArray(getData.goals), 'goals is array');
    assertOk(getData.goals.length >= 1, 'has at least one goal');
    const found = getData.goals.find(g => g.id === goalId);
    assertOk(found, 'found our goal');
    assertEq(found.type, 'daily', 'goal type matches');
    assertEq(found.target, 500, 'goal target matches');
    assertOk(typeof found.currentWords === 'number', 'has currentWords');
    assertOk(typeof found.wordsWritten === 'number', 'has wordsWritten');
    assertOk(typeof found.progress === 'number', 'has progress');
  });

  // Cleanup
  console.log(`  ${DIM}Cleaning up Journey 3 test data...${RESET}`);
  let cleanCount = 0;
  let cleanErrors = 0;

  // Delete the flashcard
  if (cardId) {
    try {
      await api('DELETE', '/api/flashcards', {userId: studyUserId, cardId});
      cleanCount++;
    } catch { cleanErrors++; }
  }

  // Goals and streak data use unique userIds, so they won't collide.
  // Goals don't have a DELETE endpoint; streak data is harmless with unique userId.

  if (cleanErrors > 0) {
    log('!', YELLOW, `Journey 3 cleanup: ${cleanCount} ok, ${cleanErrors} errors`);
  } else {
    log('✓', GREEN, `Journey 3 cleanup: ${cleanCount} items cleaned`);
  }
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}Mochi Lab -- End-to-End Workflow Tests${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}`);
  console.log(`${DIM}Testing 3 user journeys (~19 tests)${RESET}`);

  await preflight();

  await journey1();
  await journey2();
  await journey3();

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
