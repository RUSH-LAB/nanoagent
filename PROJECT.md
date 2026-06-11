# RAG Research Plan: Adaptive Retrieval Gating

## One-line summary

Train a lightweight, per-query gate that decides whether retrieval will actually help, cutting RAG cost and latency with no loss in answer quality.

## Two-sentence pitch

Most RAG systems retrieve on every query, paying latency and token cost even when the model already knows the answer or when retrieval only adds noise. We train a small gate that predicts, per query, whether retrieval improves the answer, and show it dominates the cost/accuracy frontier against always-retrieve and never-retrieve baselines.

## Why now

- Cheap long-context models make "no retrieval" a real baseline, not a fallback.
- Strong small rerankers and embedders make a tiny gate feasible without heavy infra.
- Inference cost is a genuine, widely felt pain point for anyone running RAG in production.

## Core framing

- **Tension resolved:** cost/latency versus answer quality. The hypothesis is that this trade-off is largely an artifact of always retrieving, not fundamental.
- **Abstraction level:** a context-selection policy that generalizes to any augmented-generation system, not only text RAG.
- **Beneficiary:** anyone paying per-token or per-millisecond for retrieval-augmented inference.

## Method

1. **No-RAG draft.** Run the generator once without retrieval; capture the answer plus a confidence or entropy signal.
2. **Gate features.** Query embedding combined with the no-RAG confidence signal.
3. **Gate labels.** From an offline run: did retrieval change the answer for the better? (see Experiment 1).
4. **Gate model.** Logistic regression or a small MLP, with a tunable decision threshold.
5. **Policy at inference.** Retrieve only when the gate predicts a net benefit.

## Experiments

1. **Oracle gap (1 day).** Run RAG and no-RAG on a QA subset (Natural Questions or HotpotQA, ~500 questions). Measure how often retrieval changes the answer. This upper-bounds the achievable savings.
2. **Train the gate.** Use the Experiment 1 outcomes as labels; fit the gate; tune the threshold.
3. **Cost/accuracy frontier.** Plot tokens and latency against accuracy for always-retrieve, never-retrieve, and gated. **Win condition:** the gated policy Pareto-dominates both baselines.

## Strongest objection and response

*"Model self-knowledge is unreliable, confidence is poorly calibrated."* The gate trains on retrieval-helped labels rather than raw confidence, so it learns the mapping directly. If confidence turns out to be uninformative, Experiment 1's oracle gap still quantifies the ceiling and the project pivots cleanly to calibration.

## Two-week pilot

| Days | Work |
|------|------|
| 1 to 3 | Build the no-RAG vs RAG harness; compute the oracle gap on 500 questions |
| 4 to 8 | Extract features; train the gate; tune the threshold |
| 9 to 12 | Produce the cost/accuracy frontier; ablate feature sets |
| 13 to 14 | Write up results; decide go or no-go on scaling to multi-hop |

## Success criteria

- Gated policy reduces retrieval calls meaningfully while staying within noise on accuracy.
- The frontier plot shows clear Pareto dominance.
- The gate is small enough to add negligible latency.

## Runner-up (shares the same harness)

Long-context "no-RAG" versus RAG cost/accuracy frontier. The pilot harness doubles as the setup for this study, so it is the natural follow-on.

## Completion checklist

- [x] Two-sentence pitch is clear
- [x] Problem is genuine (problem-first check passed)
- [x] Approach is simple and justified
- [x] At least one stakeholder clearly benefits
- [x] Core experiments specified
- [x] Feasibility pilot defined
- [x] Strongest objection has a response
