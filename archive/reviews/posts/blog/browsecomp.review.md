# Review: posts/blog/browsecomp.md

- Content type: research-post
- Original verdict: ACCEPT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Novelty of Insight: 4, Correctness and Soundness: 4, Evidence and Grounding: 3, Clarity and Structure: 4, Significance (So-What): 4, Honesty and Limitations: 3

## Findings
- [minor] Honesty and Limitations: "OpenSeeker-v2 shows that 10k well-curated examples with SFT alone can match or beat heavily-engineered pipelines." -> The source supports this only against the specific baseline Tongyi DeepResearch (43.4/46.7 EN/ZH vs 46.0/58.1). State the comparison baseline rather than the generic 'heavily-engineered pipelines' so the claim is not read as universal. The paper itself notes SFT does not replace RL for dynamic environments; surfacing that one-line caveat would strengthen honesty.
- [minor] Honesty and Limitations: "MiroThinker-H1 | ... | **BrowseComp** | SOTA at time of publication" -> Give the actual MiroThinker-H1 BrowseComp number(s) instead of 'SOTA at time of publication'. Since OpenSeeker-v2 (2605, 46.0% EN) post-dates MiroThinker (2603) and is also on the shared BrowseComp EN axis, the bare 'SOTA' label is ambiguous and not cross-comparable with the other two rows that carry concrete percentages. A number makes the comparison table apples-to-apples.
- [minor] Evidence and Grounding: "**Training** | SFT only (Qwen3-30B-A3B)" -> The OpenSeeker-v2 abstract states '30B-scale ReAct agents' but does not name Qwen3-30B-A3B as the base in the abstract; the model card (PolarSeeker/OpenSeeker-v2-30B-SFT) confirms 30B scale and the A3B naming is consistent, but cite or link the model card so the specific base-model attribution is traceable rather than inferred.
- [minor] Evidence and Grounding: "4. **These approaches compose.** Nothing stops you from using high-quality data (OpenSeeker) with context folding (AgentFold) and verification (MiroThinker). The next SOTA will likely combine all three." -> This is the author's forward-looking hypothesis, not a sourced result. It is appropriately hedged ('likely'), but mark it explicitly as the author's prediction to keep the established-fact vs hypothesis boundary crisp, since the surrounding takeaways are source-backed.
- [minor] Correctness and Soundness: "Context management uses a sliding window ($K=5$): only the five most recent observations are kept in full" -> The K=5 sliding-window value and the four-stage DPO/GRPO details are not in the MiroThinker abstract (only 'agentic mid-training' and local/global verification are confirmed there). These details are plausible and consistent with the paper's framing but were verifiable only at abstract level; confirm against the full PDF so the specific K value and DPO 'sole ranking signal' claim are grounded in the body text.

## Changes made
None.

## Left for human
- None

## Remaining issues after repair
None
