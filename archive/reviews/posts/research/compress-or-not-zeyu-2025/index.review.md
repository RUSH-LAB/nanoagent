# Review: posts/research/compress-or-not-zeyu-2025/index.mdx

- Content type: research-post
- Original verdict: REVISE
- Final verdict: REVISE
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Novelty of Insight: 3, Correctness and Soundness: 3, Evidence and Grounding: 2, Clarity and Structure: 4, Significance (So-What): 3, Honesty and Limitations: 2

## Re-review scores
Novelty of Insight: 3, Correctness and Soundness: 3, Evidence and Grounding: 2, Clarity and Structure: 4, Significance (So-What): 3, Honesty and Limitations: 3

## Findings
- [resolved] Honesty and Limitations (DFloat11 comparison): The "Compared to DFloat11" paragraph (line 107) now cites [@zhang2025dfloat11], acknowledges DFloat11 is itself motivated by exponent Shannon entropy, states the encode/decode pipeline (Huffman codes on exponent bits, hierarchical GPU lookup tables, GPU decode kernel) is closely related "by design," and scopes ECF8's novelty precisely to (a) the FP8 target and (b) the alpha-stable entropy-bound theory. The earlier "purely empirical observation" mischaracterization is gone. Citekey resolves in references.yaml (line 197).
- [resolved] Honesty and Limitations ("for free" claim): Line 105 no longer claims compression "for free." It now states the one cost is on-the-fly decompression overhead per weight access and that net throughput gains depend on the memory-bandwidth-bound regime (large models or large batch), citing [@zhang2025dfloat11] and tying back to the post's own memory-bandwidth observation.
- [major] Evidence and Grounding (open): Line 33, "The weights of neural networks trained with SGD are known to follow heavy tailed, $\alpha$-stable distributions," remains the load-bearing premise of the entire theoretical argument and still has NO inline citation. references.yaml contains no entry for the primary sources (e.g. Simsekli et al., Gurbuzbalaban et al.) and no heavy-tailed/alpha-stable citekey exists. This is the single blocking issue preventing ACCEPT. It was correctly left for human under the no-fabrication rule.
- [minor] Correctness and Soundness (open): Line 33, the "1.6 and 2.67 bits" Gaussian bound is an internal derivation not confirmable from the arXiv abstract; cite the exact theorem location in the paper.
- [minor] Honesty and Limitations (open): Line 11 presents the work as ICLR 2026 accepted while linking the preprint. Confirm acceptance is final and consider a brief first-party-advocacy disclosure given the "give ECF8 a try" framing (authors' own work).
- [minor] Significance So-What (open): Line 69, the headline "nearly 3x throughput improvement" (177.1%) is a weight-level microbenchmark, while the E2E table shows FLUX.1-dev at 45.9% and Wan2.1 at 3.3%. Worth stating plainly that the 3x is weight-level, not full-pipeline.

## Changes made
No new edits were made in this re-review pass. The two prior conservative edits (DFloat11 citation/scoping and the decompression-overhead caveat) were verified as present and correct: [@zhang2025dfloat11] is used at lines 105 and 107 and resolves in references.yaml. Confirmed zero em-dashes and zero en-dashes in prose; all "--" occurrences are frontmatter delimiters (lines 1, 7) and Markdown table alignment rows (lines 58, 74, 86, 99) only.

## Left for human
- [major] Evidence/Grounding: Add the primary source(s) for the heavy-tailed / alpha-stable SGD weight distribution claim (e.g. Simsekli et al., Gurbuzbalaban et al.) to references.yaml with correct bibliographic details, then insert the resolving [@citekey] after the sentence on line 33. No citekey was invented per the no-fabrication rule.
- [minor] Verify and cite the 1.6 to 2.67 bit Gaussian bound against the paper's theorem (line 33).
- [minor] Confirm ICLR 2026 acceptance status and consider a first-party disclosure (line 11).
- [minor] Clarify that the 3x throughput headline is weight-level, not end-to-end (line 69).

## Remaining issues after repair
- One blocking major issue remains: the uncited alpha-stable / heavy-tailed weight-distribution premise on line 33. Until a verified citation is added, the post stays at REVISE. The three minor items are advisory and non-blocking.
