---
slug: eisi
title: "Evolving Internet with Swarm Intelligence"
authors: [zeyu]
tags: [search, agents, knowledge-graph, synthetic-data, swarm-intelligence]
---

Today's web is flat text behind URLs. Search agents crawl it, extract what they need, and leave nothing behind. We propose a different model: every document carries structured metadata (entities, paraphrases, questions), and every agent visit enriches that metadata. The internet evolves through use.

This idea sits next to several existing lines of work, and it helps to say up front how it differs. The Semantic Web and RDF annotation programs also attach structured metadata to documents, but they depend on manual or schema-driven curation rather than on annotations produced as a byproduct of agent use. Knowledge-graph construction from text (entity and relation extraction) builds graphs once, offline, rather than treating the graph as a living artifact that every visit updates. Self-improving and self-play retrieval systems close a training loop on a fixed corpus; agent-memory and write-back systems persist what an agent learns, but usually in a private scratchpad rather than back into a shared, re-indexable web. The distinguishing claim here is the combination: a shared document graph that is enriched in place by the same agents that consume it, so the substrate and the training signal co-evolve.

<!-- truncate -->

## The Problem

Current search agents treat the web as a read-only corpus. Each agent session starts from scratch: crawl pages, extract facts, discard the intermediate work. This is wasteful. The reasoning an agent does to understand a page (identifying entities, formulating questions, discovering connections) is valuable, but it vanishes after each session.

Two capabilities are missing:

1. **A document structure rich enough to capture what agents learn.** Raw text plus hyperlinks is not enough. We need entity annotations, paraphrases, grounded questions, and cross-document links.
2. **An interaction loop that lets agents write back.** When an agent discovers a new connection or formulates a new question, that knowledge should persist for the next agent.

## Goal 1: Rich Document Object

Every document becomes a structured object with four layers:

```yaml
source: "Fibrillin-1 (FBN1) is a large extracellular-matrix glycoprotein
  encoded on chromosome 15 that polymerizes into 10-nm microfibrils..."

entities:
  - span: "Fibrillin-1 (FBN1)"
    type: gene
  - span: "Marfan syndrome"
    type: condition
  - span: "acromicric dysplasia"
    type: condition

links:
  - target: "/docs/marfan-syndrome"
    reason: "FBN1 mutations that disrupt global microfibril structure
      cause Marfan syndrome, the overgrowth end of the phenotypic spectrum"
  - target: "/docs/acromicric-dysplasia"
    reason: "FBN1 mutations in the TB5 domain cause acromicric dysplasia,
      the opposite phenotype (short stature, stiff joints)"
  - target: "/docs/tgf-beta-signaling"
    reason: "microfibrils sequester latent TGF-β; disease mechanism in
      both Marfan and acromicric dysplasia is driven by dysregulated
      TGF-β signaling"
  - target: "/docs/adamtsl2"
    reason: "ADAMTSL2 interacts with fibrillin-1 in the microfibrillar
      network; its loss causes recessive geleophysic dysplasia, a
      phenotypic sibling of acromicric dysplasia"

paraphrases:
  - span: "extracellular-matrix glycoprotein"
    alts: ["protein found outside cells", "secreted structural protein"]
  - span: "sequester"
    alts: ["trap", "store", "hold inactive"]

questions:
  - canonical: "Why do FBN1 mutations cause opposite phenotypes?"
    paraphrases:
      - "How can the same gene cause both Marfan and acromicric dysplasia?"
      - "Why does FBN1 produce tall patients and short patients?"
    answer_span: "depending on whether the mutation disrupts microfibril
      structure globally or specifically impairs the TGF-β
      binding-protein-like domain 5"
```

| Layer | What it captures | Why it matters |
|---|---|---|
| **Entities** | Named concepts that cannot be paraphrased | Graph nodes; the skeleton of the knowledge structure |
| **Links** | Cross-document references with a reason explaining *why* the connection exists | Defines adjacency for multi-hop exploration; reasons enable the agent (and the judge) to evaluate whether a link is worth traversing |
| **Paraphrases** | Alternative wordings for descriptive spans | Trains retrieval robustness; generates passage variants at scale |
| **Questions** | What an agent might ask about this document, with answer spans | Grounds QA generation in real content; each question has its own paraphrases |

The cartesian product of question paraphrases and span paraphrases generates large-scale (query, passage) training pairs automatically. This builds on a line of synthetic query and QA generation work for retrieval: doc2query [@nogueira2019document] and docTTTTTquery [@nogueira2019doc2query] expand documents with generated queries to improve indexing, and InPars-style methods [@bonifacio2022inpars] prompt large language models to synthesize (query, passage) pairs as training data. The structured object generalizes that idea by deriving queries from explicit entity, paraphrase, and question layers rather than from raw text alone. As a back-of-envelope estimate, the combinatorics suggest that one well-annotated document can yield on the order of hundreds of training examples (a handful of questions times several paraphrases each times multiple span variants); the realized number depends on annotation density and deduplication, and we have not yet measured it.

## Goal 2: Evolving Internet

The internet should not be a static snapshot. It should grow richer as agents interact with it.

The interaction loop has four steps:

1. **Arrive.** An agent lands on a document and reads both the source text and structured metadata.
2. **Explore.** The agent follows entity links to adjacent documents or searches for new pages. Each hop adds new documents to the graph.
3. **Write back.** After reading and reasoning, the agent proposes additions:
   - New paraphrases for existing spans
   - New questions the document can answer
   - New entity links discovered from cross-referencing other documents
   - New documents synthesized from combining information across pages
4. **Grow.** The next agent that visits the same document starts from a stronger foundation.

This creates a flywheel:

```
Agents train on structured data
        ↓
Agents explore and enrich documents
        ↓
Richer documents produce better training signal
        ↓
Better agents produce richer annotations
        ↓
  (repeat)
```

The internet evolves not through manual curation, but through agents continuously enriching the document graph through use.

## The Closed Loop

The evolving internet is not a vague aspiration. It requires a concrete engineering loop with three stages:

### Stage 1: Synthetic Query Generation

An LLM generates diverse queries at scale from the structured document objects. The rich metadata makes this cheap and controllable. The volume multipliers below are back-of-envelope estimates relative to the canonical-question baseline, not measured results:

| Query source | Method | Volume |
|---|---|---|
| Canonical questions | Directly from document metadata | 1x |
| Question paraphrases | LLM rewrites of canonical questions | 5-10x |
| Cross-document questions | Combine facts from linked documents | combinatorial |
| Adversarial queries | Paraphrased spans + paraphrased questions | 50-100x |

The goal is not just volume but *coverage*: every entity, every paraphrase, every multi-hop path through the document graph should be queried.

### Stage 2: Search Engine Execution

The synthetic queries hit the search engine. For each query, the system records:

- Which documents were retrieved
- What rank the correct document appeared at (or whether it was missed entirely)
- Whether the retrieved passage contained the answer span

This produces a large-scale diagnostic of where the search engine succeeds and where it fails.

### Stage 3: LLM-as-Judge Reflection

An LLM judge analyzes the search results and makes two kinds of updates:

**Updates to documents** (improving the index):
- Add missing paraphrases for spans that caused retrieval failure
- Add new questions that the search engine could not match
- Strengthen entity links where cross-document retrieval broke down
- Flag documents that need richer annotation

**Updates to the search engine** (improving retrieval):
- Re-index documents with enriched metadata
- Adjust ranking signals based on failure patterns
- Identify coverage gaps where new documents need to be crawled

### The Flywheel

```
Generate synthetic queries (from rich document objects)
        ↓
Execute against search engine
        ↓
LLM judge reflects: what failed? why?
        ↓
Update documents (richer metadata) + update search engine (better retrieval)
        ↓
Richer documents → more diverse queries → harder test cases
        ↓
  (repeat)
```

Each iteration is intended to make both the documents and the search engine stronger, with the judge turning retrieval failures into concrete improvements. The hypothesis is that the loop converges toward an internet where every reasonable way of asking a question leads to the right answer. Whether it actually converges (rather than drifts or collapses) is an open empirical question, addressed in the limitations below.

## Limitations

The convergence story is a hypothesis, and several failure modes could break it.

- **Judge reliability.** The loop is anchored on an LLM-as-judge. If the judge has systematic blind spots, it can certify its own errors as fixes and reinforce them across iterations, so the flywheel optimizes toward what the judge rewards rather than toward correctness. Calibrating the judge against held-out human labels, and using judges that differ from the generation model, are open requirements.
- **Write-back quality control.** Every agent visit can add annotations, which means the graph is only as trustworthy as its weakest contributor. Without provenance, validation, and conflict resolution, the graph is exposed to low-quality or adversarial annotation pollution that compounds as it grows. Some form of trust weighting, review, or rollback is needed before write-back can be opened up.
- **Cost of combinatorial generation.** The same combinatorics that make synthetic data cheap also make it explode. Generating, executing, and judging every paraphrase and multi-hop path is expensive, and much of the volume is likely redundant. Practical deployment probably requires sampling and difficulty-targeted generation rather than exhaustive enumeration.
- **Convergence versus drift or collapse.** A loop that trains on its own outputs can degenerate. Repeatedly learning from generated paraphrases risks the kind of distribution narrowing seen in model-collapse studies [@shumailov2023curse], and the system may drift toward easy, self-consistent queries instead of hard, useful ones. We have no proof or empirical evidence yet that the flywheel reaches a useful fixed point, and establishing that is the central open question.

## What This Enables

- **Scalable data synthesis.** Rich document objects are training data factories. Paraphrases and questions compose combinatorially, and the closed loop continuously adds new variants.
- **Self-improving search.** The search engine identifies its own blind spots through synthetic probing and fixes them automatically. However, because probes are generated from the same metadata the index is built on, probe and index can share blind spots, and the system may systematically miss gaps the annotations do not represent.
- **Adaptive difficulty.** As documents get richer and the search engine gets stronger, the system naturally produces harder QA pairs from the remaining failure cases.
