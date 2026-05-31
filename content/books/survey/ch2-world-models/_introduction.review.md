# Review: books/survey/ch2-world-models/introduction.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 12
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 3, Problem Formulation & Eval Rigor: 4

## Findings
- [resolved] Balance & Currency: The 10 body-text "--" double-hyphen occurrences flagged in the prior review (lines 8, 12, 14, 18, 20, 22, 26) have all been removed. A fresh scan of the file shows the only remaining "--" instances are the two YAML frontmatter delimiters (lines 1 and 4), which are intentional. House style in CLAUDE.md is now satisfied.
- [resolved] Balance & Currency: The currency gap is addressed. The foundation-model bullet (line 22) now anchors a verified 2025 work, with Genie 3 generating photorealistic interactive worlds from text or image prompts, citing @deepmind2025genie3. I confirmed this citekey resolves in references.yaml (line 1595, year 2025) and matches the same key used in the sibling foundation-world-models.md. The framing is no longer stale at the 2026-05 publication date.
- [verified] Scope & Coverage: The roadmap promise of "object-centric world models" (line 28) is honored. Object-centric or slot-based coverage appears in the sibling taxonomy.md and video-prediction.md, so the intro's roadmap is consistent with the deep-dive files. No change needed.
- [verified] Citation Integrity: All 24 citekeys used in the introduction resolve to entries in references.yaml, including the newly added deepmind2025genie3. No broken or fabricated references.
- [minor] Synthesis over Summary: The historical paragraph (line 14: Craik, Dyna, PILCO, Nagabandi, PETS) still reads partly as a chronological walk. It is acceptable for an intro, and the chapter-level fidelity-vs-utility thesis (line 28) supplies the overarching arc, but a single comparative takeaway sentence inside that paragraph tying the lineage to the central tension would strengthen it. Non-gating polish.
- [minor] Scope & Coverage: The new boundaries paragraph (line 30) is a strong addition, stating in-scope and out-of-scope clearly and handling boundary-crossing cases such as Sora. No issues.

## Changes made
None by this reviewer. The prior reviser's edits were verified independently: all body-text double-hyphen em-dashes removed and one verified 2025 anchor (@deepmind2025genie3) added. Both repairs are correct and complete.

## Left for human
- Currency (optional): Only one 2025 anchor is present. If additional verified 2025 world-model anchors exist in references.yaml (for example an updated GAIA or a 2025 video-world-model line), a human could pull one more forward. This is enrichment, not a blocker.
- Synthesis (optional): Consider adding one comparative takeaway sentence to the historical paragraph (line 14) connecting the classical lineage to the fidelity-vs-utility tension.

## Remaining issues after repair
None blocking. Two optional minor polish items noted above.
