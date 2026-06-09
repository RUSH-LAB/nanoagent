# Review: books/survey/ch2-world-models/video-prediction.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 3, Synthesis over Summary: 2, Citation Integrity: 3, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 3, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Verification of prior repairs
- STORM date corrected: in-text now reads "Zhang et al., 2023"; references.yaml entry zhang2025storm_wm has year: 2023, venue NeurIPS, url arxiv.org/abs/2310.09615. Confirmed.
- FitVid reframed: paragraph now centers on the underfitting-vs-overfitting diagnosis and the data-augmentation contribution (RandAugment plus random cropping) rather than the generic engineering-over-novelty claim. Confirmed.
- Diffusion comparative takeaway added: new paragraph contrasts pixel-space cascade vs latent diffusion vs text-decoupled vs autoregressive-token paradigms and states the shared fidelity-vs-compute tradeoff. Confirmed.
- Scope statement added: opening now defines in-scope (future-frame generation for prediction and decision-making) vs out-of-scope (pure text-to-video and single-image generation) with an explicit inclusion criterion for general video generators. Confirmed.
- All citekeys in the file resolve against references.yaml. No em-dashes or en-dashes present; the only "--" are MDX frontmatter delimiters.

## Findings (remaining, all improvement-level)
- [minor] Taxonomy Quality: top-level sections still mix organizing principles. Early Video Prediction, SVG, and FitVid are chronological/single-method while Autoregressive, Diffusion, and Object-Centric are architectural families. Folding SVG and FitVid into a VAE-based / latent-variable family would give one consistent axis. Not addressed; non-blocking.
- [minor] Problem Formulation and Eval Rigor: "iVideoGPT showed that scaling VideoGPT-style models creates increasingly capable world simulators, with performance improving predictably with model size and data." This scaling-law-style claim still has no metric, benchmark, or number. Either ground it or soften "predictably".
- [minor] Citation Integrity / Eval Rigor: the STORM comparative claim ("competitive performance with DreamerV3 on Atari 100k while being significantly faster to train") remains qualitative. Stating the headline figure (126.7% mean human performance) and concrete training cost would ground it.
- [info] Deferred by prior pass: citekey rename zhang2025storm_wm to zhang2023storm (global, cross-chapter) and a full comparative table for the seven diffusion systems (needs source-verified resolution/fps/training-data figures). Both correctly left for a human; neither blocks acceptance since the rendered year is now correct and a comparative prose takeaway is present.

## Rationale for ACCEPT
All four major findings from the original review were addressed: the STORM dating error (Balance and Currency / Citation Integrity), the misstated FitVid result and the diffusion annotated-bibliography (both Synthesis over Summary), and the missing scope boundary (Scope and Coverage). Synthesis, Citation Integrity, and Balance each moved up a point. The Taxonomy gate passes (navigable, families internally coherent). The three remaining issues are minor grounding and consistency refinements that do not undermine correctness or usability.

## Remaining issues after repair
- Taxonomy still mixes chronological and architectural top-level axes (minor).
- iVideoGPT scaling claim and STORM comparative claim lack quantitative grounding (minor).
- Citekey rename and diffusion comparison table left for a human (info).
