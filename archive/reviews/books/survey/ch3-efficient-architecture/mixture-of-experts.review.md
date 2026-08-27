# Review: books/survey/ch3-efficient-architecture/mixture-of-experts.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 3, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 4

## Re-review scores
Scope and Coverage Completeness: 5, Taxonomy Quality (gate): 5, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Verification
- All 12 citekeys resolve in references.yaml: jacobs1991adaptive, jordan1994hierarchical, shazeer2017outrageously, lepikhin2021gshard, fedus2022switch, zoph2022stmoe, jiang2024mixtral, dai2024deepseekmoe, deepseek2024deepseekv2, deepseek2024deepseekv3, lewis2021base, zhou2022expert_choice.
- New entries deepseek2024deepseekv2 (arXiv 2405.04434) and deepseek2024deepseekv3 (arXiv 2412.19437) are well-formed with correct arXiv IDs.
- No em-dash, en-dash, or double-dash characters in prose. The only "---" matches are frontmatter delimiters (lines 1, 4) and the markdown table separator (line 80).

## Resolution of original major findings
- [resolved] Synthesis over Summary (annotated-bibliography pattern): An opening paragraph now frames the section around three comparative axes (routing strategy, expert granularity, shared vs fully-routed), and GShard, Switch, ST-MoE, and Mixtral subsections each close with an explicit comparative takeaway tying back to those axes. The chronological order is now justified rather than a raw list.
- [resolved] Synthesis over Summary (missing comparison table): A "Comparing the MoE Family" subsection adds a table across Shazeer, GShard, Switch, ST-MoE, Mixtral, DeepSeek-MoE, DeepSeek-V3, BASE, and Expert Choice on routing strategy, experts/top-k, granularity, shared experts, and total/active params, followed by a cross-row synthesis sentence. Cells for design studies and routing methods are correctly marked n/a rather than fabricated.
- [resolved] Citation Integrity (uncited 671B/37B claims): The load-bearing DeepSeek-V2/V3 figures now cite deepseek2024deepseekv2 and deepseek2024deepseekv3, both added to references.yaml.
- [resolved] Balance and Currency (auxiliary-loss-free load balancing absent): DeepSeek-V3's auxiliary-loss-free load balancing is documented in the DeepSeek-MoE subsection and in the Challenges load-imbalance bullet, explicitly tied to the "do not fully solve" statement.

## Remaining issues after repair
- [minor] Balance and Currency: per-family limitations are still concentrated in the closing Challenges section rather than surfaced inline within each subsection (e.g., Mixtral's 47B memory footprint despite 13B active compute). Each family reads somewhat one-sided locally.
- [minor] Balance and Currency: other 2024-2025 open MoE models (Qwen-MoE, DBRX, Grok) remain absent. Correctly not fabricated; a human must supply verifiable references.yaml entries and figures before they can be cited.
- [minor] Problem Formulation and Evaluation Rigor: the noisy-softmax gate G(x) = softmax(W_g x + epsilon) presents fixed-variance noise and omits Shazeer's learned per-expert noise scale (StandardDeviation = Softplus(x * W_noise)); could note it is a simplification.
- [minor] Citation Integrity: the DeepSeek-MoE description "64 experts with top-6 routing" precedes the introduction of shared experts; these are 64 routed experts plus 2 always-active shared experts in DeepSeekMoE-16B. Slight phrasing imprecision, clarified in the very next point but not at first mention.

These are all minor polish items and do not block publication. The taxonomy gate passes and all four original major findings are resolved, clearing ACCEPT.
