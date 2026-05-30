export const meta = {
  name: 'literature-review',
  description: 'Fan out a survey/literature-review: gather sources, build a taxonomy, draft sections, verify every citation, synthesize tradeoffs',
  whenToUse: 'Writing or extending a survey chapter under content/books/survey. Pass args: { topic, chapterPath, depth }.',
  phases: [
    { title: 'Scope', detail: 'define the survey question, axes, and inclusion criteria' },
    { title: 'Gather', detail: 'fan out source discovery across subtopics' },
    { title: 'Taxonomy', detail: 'cluster sources into a mutually-exclusive taxonomy' },
    { title: 'Draft', detail: 'one agent per section archetype, synthesis not summary' },
    { title: 'Verify', detail: 'check every citation is real and grounded' },
    { title: 'Review', detail: 'score the assembled chapter against the survey rubric, return a verdict' },
    { title: 'Repair', detail: 'rewrite flagged sections and re-review until ACCEPT or max rounds' },
  ],
}

// args: { topic: string, chapterPath?: string, depth?: number }
const topic = (args && args.topic) || 'the requested survey topic'
const chapterPath = (args && args.chapterPath) || 'content/books/survey/<chapter>'
const DEPTH = (args && args.depth) || 6

const HOUSE = `House style: never use "--" or em-dashes; thesis-first; synthesis over per-paper summary. Citations are pandoc-style [@citekey] / [@key1, @key2], woven into prose with author-year. Frontmatter: sidebar_position + title.`

// --- Phase 1: Scope ---
phase('Scope')
const SCOPE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    question: { type: 'string' },
    axes: { type: 'array', items: { type: 'string' }, description: 'taxonomy axes that organize the field' },
    subtopics: { type: 'array', items: { type: 'string' }, description: 'search-worthy subtopics to fan out over' },
    inclusion: { type: 'string', description: 'PRISMA-style inclusion/exclusion criteria' },
  },
  required: ['question', 'axes', 'subtopics'],
}
const scope = await agent(
  `Scope a literature-review survey on: ${topic}.
Read any existing draft at ${chapterPath} to avoid duplication and match its framing.
Produce: the precise survey question, the 2-4 organizing taxonomy axes (mutually exclusive where possible), ${DEPTH} concrete search-worthy subtopics, and PRISMA-style inclusion criteria (what counts as in-scope, what to exclude).
${HOUSE}`,
  { phase: 'Scope', schema: SCOPE_SCHEMA }
)
log(`Scoped: ${scope.subtopics.length} subtopics across axes: ${scope.axes.join(', ')}`)

// --- Phase 2+3: gather sources per subtopic, then cluster (pipeline: gather -> cluster-tag) ---
const SOURCES_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    subtopic: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          authors: { type: 'string' },
          year: { type: 'string' },
          citekey: { type: 'string', description: 'suggested bibtex citekey, e.g. author2024keyword' },
          url: { type: 'string' },
          contribution: { type: 'string', description: 'one-line what-is-new' },
          axis: { type: 'string', description: 'which taxonomy axis it sits on' },
        },
        required: ['title', 'year', 'citekey', 'contribution'],
      },
    },
  },
  required: ['subtopic', 'sources'],
}

phase('Gather')
const gathered = await parallel(
  scope.subtopics.map((st) => () =>
    agent(
      `Gather the most important, real, verifiable sources on this subtopic of "${topic}": "${st}".
Use web search to find seminal and recent (last 2 years) papers. For each, capture title, authors, year, a real URL, a suggested citekey, a one-line contribution, and which of these axes it sits on: ${scope.axes.join(' | ')}.
Only include sources you can actually verify exist. Do not invent papers or citekeys for papers you cannot confirm.
${HOUSE}`,
      { label: `gather:${st.slice(0, 30)}`, phase: 'Gather', schema: SOURCES_SCHEMA }
    )
  )
)

const allSources = gathered.filter(Boolean).flatMap((g) => g.sources)
log(`Gathered ${allSources.length} candidate sources`)

// --- Phase: Taxonomy (barrier justified: needs ALL sources to dedup + organize) ---
phase('Taxonomy')
const TAXONOMY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          archetype: { type: 'string', description: 'introduction | problem-formulation | taxonomy | method-family | benchmarks | open-problems' },
          citekeys: { type: 'array', items: { type: 'string' } },
          angle: { type: 'string', description: 'the comparative thesis this section argues' },
        },
        required: ['title', 'archetype', 'citekeys', 'angle'],
      },
    },
  },
  required: ['sections'],
}
const taxonomy = await agent(
  `Here are ${allSources.length} sources for a survey on "${topic}":
${JSON.stringify(allSources, null, 2)}

Dedup them, then organize into a coherent chapter outline along these axes: ${scope.axes.join(' | ')}.
Return the list of sections. Each section has a title, an archetype, the citekeys it covers, and a one-line comparative angle (the tradeoff or tension it argues, not a topic label).
Aim for synthesis: group methods that navigate the same tradeoff together.
${HOUSE}`,
  { phase: 'Taxonomy', schema: TAXONOMY_SCHEMA }
)
log(`Taxonomy: ${taxonomy.sections.length} sections`)

// --- Phase 4+5: draft each section, then verify its citations (pipeline) ---
const sourceByKey = {}
for (const s of allSources) sourceByKey[s.citekey] = s

const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' },
    markdown: { type: 'string', description: 'the section body in MDX, pandoc citations' },
    usedCitekeys: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'markdown', 'usedCitekeys'],
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' },
    markdown: { type: 'string' },
    unverifiedCitekeys: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'markdown'],
}

phase('Draft')
const sections = await pipeline(
  taxonomy.sections,
  (sec) => agent(
    `Draft the "${sec.title}" section (archetype: ${sec.archetype}) of a survey on "${topic}".
Comparative angle to argue: ${sec.angle}
Sources available (cite by citekey with pandoc syntax [@citekey]):
${JSON.stringify(sec.citekeys.map((k) => sourceByKey[k]).filter(Boolean), null, 2)}

Write synthesis, not a list: compare and contrast methods, name the tradeoff each navigates, end with a comparative takeaway. Weave author-year naturally. Use only the citekeys provided.
${HOUSE}`,
    { label: `draft:${sec.title.slice(0, 28)}`, phase: 'Draft', schema: DRAFT_SCHEMA }
  ),
  (draft) => agent(
    `Verify citation integrity for this drafted survey section.
For each pandoc citekey used, confirm a real source backs it (use web search to spot-check the riskiest claims and any citekey not in the provided source list). Flag any citekey you cannot verify in unverifiedCitekeys, and remove or soften unsupported claims. Fix any "--"/em-dash. Return the cleaned markdown.

Section:
${draft.markdown}

Known-good sources: ${JSON.stringify(Object.keys(sourceByKey))}`,
    { label: `verify:${draft.title.slice(0, 28)}`, phase: 'Verify', schema: VERIFY_SCHEMA }
  ),
)

const clean = sections.filter(Boolean)
const usedKeys = [...new Set(clean.flatMap((s) => s.markdown.match(/@[A-Za-z0-9_]+/g) || []))]

// --- Phase: Review gate (Rubric C from the review-draft skill) ---
phase('Review')
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['ACCEPT', 'REVISE', 'REJECT'] },
    decidingFinding: { type: 'string' },
    scores: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { dimension: { type: 'string' }, score: { type: 'integer' }, reason: { type: 'string' } },
        required: ['dimension', 'score'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          dimension: { type: 'string' },
          quote: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'quote', 'fix'],
      },
    },
  },
  required: ['verdict', 'decidingFinding', 'scores', 'findings'],
}
const reviewChapter = (secs, round) => agent(
  `Review this assembled survey chapter on "${topic}" for SUBSTANCE using Rubric C of the review-draft skill (.claude/skills/review-draft/SKILL.md). This is review round ${round}. Score each of the six dimensions 1-5 (Scope and Coverage, Taxonomy Quality [gate], Synthesis over Summary, Citation Integrity, Balance and Currency, Problem Formulation and Evaluation Rigor), tag findings by severity (blocker/major/minor), quote the offending line or citekey, and return one verdict.
Taxonomy Quality is a gate: REJECT if it scores 2 or below. REJECT on any unresolved blocker (a number a cited source does not contain, a nonexistent citekey, a result credited to a survey not its origin).

Chapter sections:
${secs.map((s) => `## ${s.title}\n${s.markdown}`).join('\n\n')}

Known-good sources: ${JSON.stringify(Object.keys(sourceByKey))}`,
  { label: `review:r${round}`, phase: 'Review', schema: REVIEW_SCHEMA }
)

// match a finding to a section by quoted text
const matchSection = (secs, f) => f.quote && secs.find((sec) => sec.markdown.includes(f.quote.slice(0, 40)))

const MAX_ROUNDS = (args && args.maxReviewRounds) || 2
let working = clean
let round = 1
let review = await reviewChapter(working, round)
log(`Review round ${round}: ${review.verdict} (${review.findings.filter((f) => f.severity !== 'minor').length} non-minor findings)`)

// --- Self-correcting REVISE loop: rewrite flagged sections, then re-review ---
let unresolvedStructural = []
while (review.verdict !== 'ACCEPT' && round <= MAX_ROUNDS) {
  const actionable = review.findings.filter((f) => f.severity !== 'minor')
  if (!actionable.length) break

  const prev = working
  unresolvedStructural = actionable.filter((f) => !matchSection(prev, f))
  if (unresolvedStructural.length) {
    log(`${unresolvedStructural.length} structural findings need a manual fix (new section, missing source); not auto-revised`)
  }

  phase('Repair')
  log(`Repair round ${round}: rewriting flagged sections`)
  const revised = await parallel(
    prev.map((sec) => () => {
      const fixes = actionable.filter((f) => matchSection(prev, f) === sec)
      if (!fixes.length) return Promise.resolve(sec)
      return agent(
        `Revise the survey section "${sec.title}" to fix these reviewer findings. Make the minimal change that resolves each finding without weakening correct content. Keep pandoc citations [@key] and use only verifiable sources. Never use "--" or em-dashes.

Findings to fix:
${fixes.map((f) => `- [${f.severity}] ${f.dimension || ''}: "${f.quote}" -> ${f.fix}`).join('\n')}

Current section markdown:
${sec.markdown}

Known-good sources: ${JSON.stringify(Object.keys(sourceByKey))}`,
        { label: `repair:${sec.title.slice(0, 24)}`, phase: 'Repair', schema: DRAFT_SCHEMA }
      ).then((r) => ({ title: sec.title, markdown: r.markdown, usedCitekeys: r.usedCitekeys || [] })).catch(() => sec)
    })
  )
  working = revised.map((x, i) => x || prev[i])

  round++
  review = await reviewChapter(working, round)
  log(`Review round ${round}: ${review.verdict} (${review.findings.filter((f) => f.severity !== 'minor').length} non-minor findings)`)
}

if (review.verdict !== 'ACCEPT') {
  log(`Stopped at ${review.verdict} after ${round} rounds. Remaining findings need a human pass.`)
}

const finalKeys = [...new Set(working.flatMap((s) => s.markdown.match(/@[A-Za-z0-9_]+/g) || []))]

return {
  topic,
  chapterPath,
  scope,
  taxonomy: taxonomy.sections,
  sections: working,
  bibliography: finalKeys.map((k) => sourceByKey[k.slice(1)]).filter(Boolean),
  review,
  reviewRounds: round,
  unresolvedStructural,
}
