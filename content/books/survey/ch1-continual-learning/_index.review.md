# Review: books/survey/ch1-continual-learning/index.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 5, Taxonomy Quality: 5, Synthesis over Summary: 4, Citation Integrity: 3, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 5

## Re-review scores
Scope and Coverage Completeness: 5, Taxonomy Quality (gate): 5, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 5

## Findings
- [resolved] Problem Formulation and Evaluation Rigor: the two ASCII "--" em-dash substitutes formerly in the chapter overview paragraph have been replaced with commas ("...continual learning, the ability..." and "...large language models, including continual pre-training..."). index.md prose now contains zero em-dash substitutes. The two remaining "---" lines are the intentional YAML frontmatter delimiters. House rule satisfied.
- [resolved] Citation Integrity: the original "MRCL combines meta-learning with replay [@arani2022learning]" wrong-source attribution does not exist in the chapter. Verified against meta-continual-learning.md where the content actually lives: OML is correctly attributed to [@javed2019meta] with an explicit note that it was originally introduced as MRCL, and CLS-ER is correctly attributed to [@arani2022learning] and described as a dual-memory exponential-moving-average experience-replay method (not meta-learning, not named MRCL). No conflation, no phantom method, no duplication of OML.
- [confirmed] Citation Integrity: the DER acronym collision (Dynamically Expandable Representation vs Dark Experience Replay) remains correctly disambiguated; no change needed.
- [note] Balance and Currency: the original "classifier bias in Class-IL" cross-link suggestion concerns regularization-methods.md and replay-methods.md, not index.md; out of scope for the assigned file and does not affect its score.

## Changes made
None in this pass. index.md was already corrected by the prior revision (em-dash substitutes removed, frontmatter preserved). Verified independently that no broken or wrong-source citekeys remain and that the index accurately mirrors the chapter body files.

## Left for human
- Optional, non-blocking: consider adding a single cross-link reconciling the "classifier bias in Class-IL" diagnosis shared by regularization-methods.md (LUCIR/BiC/WA) and replay-methods.md (SS-IL) so the same phenomenon is not presented as two independent discoveries. This is a body-file polish item, not an index.md blocker.

## Remaining issues after repair
None
