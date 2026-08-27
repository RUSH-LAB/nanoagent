# Review: books/survey/ch3-efficient-architecture/peft.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0 (prose); the only "---" tokens are the YAML frontmatter delimiters and the markdown table separator, both required syntax
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 5, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 5, Synthesis over Summary: 5, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Findings
- [resolved] Taxonomy Quality (gate): The chapter now states an explicit top-level taxonomy in the intro (three axes: reparameterization/low-rank, additive modules, input/activation steering) and groups the per-method subsections under three named family headings, each opening with its organizing principle and characteristic tradeoff. The gate concern is cleared.
- [resolved] Synthesis over Summary: Each method subsection now closes with a one-sentence comparative takeaway stating the regime in which it wins or loses relative to plain LoRA, and a dedicated "Comparative Analysis" section adds a cross-family table plus a synthesis paragraph naming the central tension (training-memory reduction vs inference-time neutrality vs expressiveness). No longer an annotated-bibliography pattern.
- [resolved] Balance and Currency: LoRA's limitation (fixed low-rank subspace capping expressiveness, which motivates DoRA and GaLore) is now stated in the Comparative Analysis section, balancing the earlier praise.
- [minor, open] Citation Integrity: Line 32 still says QLoRA "loads it in FP16 for computation, and trains LoRA adapters in FP16." Per the QLoRA paper the compute dtype is BFloat16 (BF16), not FP16. Change both occurrences to "BFloat16 (BF16)".
- [minor, open] Correctness: Line 18 still describes Houlsby adapters as "small bottleneck layers inserted between the layers of a pre-trained transformer." They are inserted within each transformer layer (after the attention and feed-forward sub-layers). Reword to match the paper.
- [minor, open] Problem Formulation and Evaluation Rigor: Line 18 uses the loose "3-5%" paraphrase; the Houlsby paper reports 3.6%. Use the exact figure. GLUE is referenced but never glossed; a one-line description of what it measures would aid the reader.
- [minor, open] Scope and Coverage Completeness: No explicit scope/out-of-scope boundary is drawn; recognized family members (AdaLoRA, (IA)^3, BitFit, LoRA+) are omitted without acknowledgment. One sentence naming what is covered vs out of scope would make coverage legible.

## Decision rationale
The gate dimension (Taxonomy Quality) now scores 5 and all three major findings from the original review are resolved. The remaining items are all minor (a dtype label, an architectural wording nuance, a rounded figure, an optional scope sentence) and were correctly held back by the reviser as factual changes that should not be invented. None block publication. Verdict: ACCEPT.

## Remaining issues after repair
- QLoRA compute dtype labeled FP16; should be BFloat16 (BF16), two occurrences on line 32.
- Adapter placement described as "between the layers"; should be "within each transformer layer, after the attention and feed-forward sub-layers" (line 18).
- "3-5%" adapter figure should be the exact 3.6% from the paper; GLUE undefined for the reader (line 18).
- No explicit scope boundary; AdaLoRA, (IA)^3, BitFit, LoRA+ omitted without acknowledgment.
