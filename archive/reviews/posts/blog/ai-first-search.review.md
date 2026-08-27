# Review: posts/blog/ai-first-search.md

- Content type: research-post
- Original verdict: ACCEPT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Novelty of Insight: 3, Correctness and Soundness: 4, Evidence and Grounding: 4, Clarity and Structure: 4, Significance (So-What): 3, Honesty and Limitations: 3

## Findings
- [minor] Correctness and Soundness: "Inference optimization keeps end-to-end latency at 358ms median (p95 under 800ms), faster than all tested alternatives including Brave." -> Verified accurate (p95 is 763ms; Brave p95 is 808ms and p50 513ms, both slower than Perplexity). No change required, but consider stating Brave's p95 of 808ms explicitly since 'under 800ms' versus a competitor at 808ms is the tight comparison carrying the 'faster than all' claim.
- [minor] Honesty and Limitations: "Perplexity benchmarked against Exa, Brave, and Tavily (a Google SERP-based API) across four tasks spanning simple factoid QA to deep multi-hop research." -> These are Perplexity's own self-reported benchmarks run by the vendor (the post even notes 'they win'). Add one sentence flagging that the evaluation is vendor-run and not yet independently reproduced, so a reader does not treat the table as a neutral third-party comparison. The post hedges elsewhere but never states this self-reporting caveat directly.
- [minor] Correctness and Soundness: "The gap is largest on hard tasks (BrowseComp, HLE) and on latency." -> True in relative terms versus the strongest competitor (HLE: .288 vs .248 = +16% rel; BrowseComp +6.6% rel; SimpleQA +4.5%; FRAMES +3.7%) but in absolute points SimpleQA (+.040) ties HLE (+.040). Clarify 'gap' means relative/proportional gain to avoid a reader checking absolute deltas and finding SimpleQA equal.
- [minor] Significance (So-What): "**3. The product-as-evaluator flywheel is the real moat.**" -> This is the author's strongest editorial claim and it is asserted rather than argued against the obvious counter (Google has decades of richer interaction signal at far larger scale). Acknowledge that incumbents also have dense feedback loops, so the moat is about signal type (answer-grounded vs click) rather than existence, to keep scope proportional.
- [minor] Novelty of Insight: "This is the most novel part of the system." -> Self-evolving / LLM-evaluated parsing rulesets are framed as singularly novel; brief acknowledgment of prior art (wrapper induction, automated web extraction, LLM-as-judge for extraction) would make the 'new' claim more legible per the rubric's related-work check. Optional, does not change the takeaway.

## Changes made
None.

## Left for human
- None

## Remaining issues after repair
None
