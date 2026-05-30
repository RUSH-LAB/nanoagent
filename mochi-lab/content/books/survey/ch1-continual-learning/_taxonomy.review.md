# Review: books/survey/ch1-continual-learning/taxonomy.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 5, Synthesis over Summary: 4, Citation Integrity: 3, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 5, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Findings
- [resolved] Citation Integrity (was major): The pretrained-vs-scratch thesis is now attributed to lee2023pretrained (Lee, Zhong, Wang, WACV 2023, "Do Pre-trained Models Benefit Equally in Continual Learning?") instead of the ANCL paper kim2023achieving. The new clause "Lee et al. show empirically that algorithm rankings can change drastically once pre-training is introduced" accurately reflects that source. The citekey lee2023pretrained exists in references.yaml (line 4011). All citekeys in the file resolve against references.yaml; no broken references.
- [resolved] Taxonomy Quality / house style (was minor, gate-adjacent): All three prose "--" occurrences are gone. The only remaining double-dashes are the structural YAML frontmatter delimiters on lines 1 and 4, which are not prose.
- [minor, open] Citation Integrity: Line 8 still stacks four surveys behind the five-family claim, including parisi2019continual and delange2021continual, both of which predate the prompt-based family (L2P and DualPrompt are 2022) and so cannot support family 5. Narrowing the cluster to wang2024comprehensive and masana2023class, or splitting cites per family, would remove the coverage-laundering risk. Does not gate.
- [minor, open] Synthesis over Summary: Line 12 ("Replay methods are currently the dominant paradigm, consistently achieving state-of-the-art results across settings") and the cross-setting comparisons in the Comparative Analysis section remain entirely qualitative. One grounded number, such as a Class-IL accuracy gap between a replay method and EWC at a fixed buffer on Split-CIFAR100, would strengthen the dominance claim. Does not gate.
- [minor, open] Scope and Coverage Completeness: Line 16 still names "metric-based approaches" as a sub-branch of the meta-learning family with no representative method or citekey, unlike every other leaf, which names flagship methods. Either name a representative metric-based continual-learning method or drop the sub-branch. Does not gate.

## Decision rationale
The single major issue (a citation misattribution that undermined Citation Integrity) and the gate-adjacent house-style violation are both fully repaired and verified against the source file and references.yaml. The three open items are all minor, non-gating polish items that do not affect correctness, the taxonomy structure (gate dimension, scored 5), or the integrity of the now-correct citations. Verdict moves from REVISE to ACCEPT.

## Remaining issues after repair
- [minor] Four-survey cite cluster on line 8 includes two surveys that predate the prompt-based family.
- [minor] Replay-dominance and cross-setting comparisons are qualitative; no grounded numbers.
- [minor] "metric-based approaches" sub-branch has no representative method or citekey.
