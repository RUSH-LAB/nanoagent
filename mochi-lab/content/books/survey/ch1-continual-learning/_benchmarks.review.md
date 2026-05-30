# Review: books/survey/ch1-continual-learning/benchmarks.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Evaluation Rigor: 4

## Re-review scores
Scope & Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Evaluation Rigor: 4

## Findings (this pass)
- [resolved][major] Synthesis over Summary: The previously unsourced "often 10-20%" Split-CIFAR-100 gap claim is now qualified non-numerically as "informally reported in the tens of percentage points, with the exact magnitude depending heavily on the setting, backbone, and memory budget." This removes the load-bearing unsourced number while preserving the takeaway. Acceptable.
- [resolved][major] Synthesis over Summary: Bare benchmark entries now carry scale figures (Rotated MNIST: 10-class with rotation-angle tasks; Split-CUB-200: 200 species, 10 tasks of 20 classes; VTAB Sequence: three-category grouping). A closing comparative-takeaway paragraph (line 32) synthesizes what the pre-trained-model benchmarks test and notes that larger distribution shifts separate methods more sharply. The section now reads as synthesis rather than an annotated list.
- [open][minor] Taxonomy Quality: Split-ImageNet-R is still introduced under Image Classification Benchmarks (line 17) and defined again in full under Benchmarks for Pre-Trained Models (line 28). The duplication remains; consolidating to the pre-trained section would keep the grouping MECE. Does not break the gate.
- [open][minor] Scope & Coverage: No explicit scope/out-of-scope boundary is stated, and recent streaming/online-CL benchmarks (CLEAR, Stream-51, NEVIS'22, OpenLORIS) are absent without acknowledgement. A one-line scope statement or explicit omission note would close this.
- [open][minor] Problem Formulation & Evaluation Rigor: CORe50 entry is accurate but thin: it omits the image-count scale (164,866 RGB-D images) and the NI/NC/NIC scenario types. Adding these would meet the rubric's scale-and-key-numbers bar.

## Decision rationale
The gating dimension (Taxonomy Quality) is sound: groupings are coherent and labeled. Both prior major issues are fixed. Citation integrity is verified (all 12 citekeys resolve in references.yaml). Remaining items are all minor and non-blocking, so the chapter clears the bar for ACCEPT.

## Verification performed
- All 12 citekeys checked against /Users/zy45/Documents/Code/mochi-lab/mochi-lab/references.yaml: all resolve, none broken.
- Body scanned for em-dashes and double-hyphens: none found (only frontmatter delimiters remain).

## Remaining issues after repair
- [minor] Split-ImageNet-R duplicated across the Image Classification and Pre-Trained Models buckets; consolidate to one home.
- [minor] No explicit scope statement; streaming/online-CL benchmarks omitted without acknowledgement.
- [minor] CORe50 entry lacks image-count scale and NI/NC/NIC scenario types.
