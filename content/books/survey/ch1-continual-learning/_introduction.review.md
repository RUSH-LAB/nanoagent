# Review: books/survey/ch1-continual-learning/introduction.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 3, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Verification performed
- Counted "--" in the file: only two occurrences, both the YAML frontmatter delimiters on lines 1 and 4 (required structural markers). Zero "--" remain in prose. House-style gate now passes.
- Resolved all 23 citekeys against mochi-lab/references.yaml. Every key (mccloskey1989catastrophic, ratcliff1990connectionist, french1999catastrophic, grossberg1980how, mcclelland1995there, kumaran2016what, parisi2019continual, delange2021continual, wang2024comprehensive, scialom2025continual, jang2022towards, wu2024continual_llm_survey, ji2007coordinated, shin2017continual, abraham2008metaplasticity, kirkpatrick2017overcoming, wang2022learning_l2p, wang2022dualprompt, lee2021continual, masana2023class, rusu2016progressive, mendez2022modular_cl) is present. No broken citekeys.

## Findings (status after revision)
- [resolved] Citation Integrity (major): The fabricated de Lange et al. (2021) Split-CIFAR-100 "90% to below 20% after 10 tasks" claim has been removed. Line 24 now reads that naive sequential fine-tuning "leaves performance on early tasks far below that of joint training across a range of task-incremental image classification benchmarks," which matches what de Lange et al. actually evaluate (task-incremental image classification, not Split-CIFAR-100). No fabricated number remains.
- [resolved] Citation Integrity (house style): All prose "--" occurrences removed; parentheticals converted to parentheses and dash-bounded clauses to commas; the range is now "10 to 20."
- [open, minor] Citation Integrity / Balance and Currency: Line 24 still calls Masana et al. (2023) "the most comprehensive evaluation of class-incremental methods." This superlative is dated given Zhou et al. (2024) evaluate 16 methods. Soften to "one of the most comprehensive evaluations as of 2023." Minor, not a fabrication.
- [open, minor] Citation Integrity: The "10 to 20 percentage points" gap on challenging benchmarks (line 24) was not verified against the primary Masana et al. tables in this review. It reads as a precise load-bearing figure; confirm against the paper's results tables or qualify as approximate with the specific benchmark cited.
- [open, minor] Synthesis over Summary: The forward-transfer paragraph (line 26) still asserts that the few forward-transfer methods "achieve it in limited settings" without a concrete metric or named regime. Adding one grounded comparative number would lift synthesis, but this is a polish item, not a correctness issue.

## Verdict rationale
The two blocking issues from the original review (a fabricated benchmark/number that could not be attributed to its cited source, and a repo-wide house-style violation) are both fully resolved. All citekeys validate and zero em-dashes remain in prose. The three open items are minor qualification and polish suggestions; none is a fabrication, miscitation, or build break, so they do not block acceptance. Citation Integrity rises from 3 to 4. Verdict: ACCEPT, with the open minor items handed to the human as optional improvements.

## Remaining issues after repair
- Soften the "most comprehensive evaluation" superlative for Masana et al. (2023), or qualify it as "as of 2023" (minor).
- Verify or qualify the "10 to 20 percentage points" gap against the primary Masana et al. results tables (minor).
- Optionally ground the forward-transfer "limited settings" claim with a concrete metric or benchmark regime (minor, polish).
