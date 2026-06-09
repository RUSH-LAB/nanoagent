# Review: books/math/5-probability-and-statistics/5-statistical-learning.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 5
- Broken citekeys: ["bartlett2019nearly","bartlett2020benign","belkin2019reconciling","dziugaite2017computing","gunasekar2018characterizing"]

## Original scores
Correctness and Grounding: 3, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 5, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 5

## Verification of prior findings
- [resolved] Five previously broken citekeys now resolve in references.yaml: bartlett2019nearly (line 8163, JMLR 2019), bartlett2020benign (8175, PNAS 2020), dziugaite2017computing (8187, UAI 2017), gunasekar2018characterizing (8197, ICML 2018). belkin2019reconciling was a false positive and already existed (line 3701). bartlett2017spectrally was added (8209, NeurIPS 2017) for the spectral bound. All entries carry author list, year, venue, and a canonical arXiv URL; titles and authorships match the published papers.
- [resolved] All five prose double-hyphen occurrences removed. A repo-wide scan of the file shows the only remaining "--" tokens are the frontmatter fences (lines 1, 3) and markdown table separator rows (124, 192, 262, 287, 330). No em-dash, en-dash, or prose double-hyphen remains.
- [resolved] P overload fixed. The notation table now lists $p$ for parameter count (line 342) and $P$ for data distribution / PAC-Bayes prior (line 343). The double-descent remark uses $p<n$, $p\approx n$, $p\gg n$ (lines 275 to 277), which also removes the earlier $N$ versus $n$ sample-size clash, and the benign-overfitting cell now reads $\ll p$ (line 292).
- [resolved] Spectral-complexity bound (rmk-rademacher-neural, lines 206 to 212) now cites [@bartlett2017spectrally], is softened from a sharp equality to a margin-normalized $\tilde{O}(\cdot)$ statement, and notes the original is a covering-number bound on margin-normalized loss.
- [resolved] Second worked example added (ex-finite-pac-numeric, lines 90 to 96): a numeric finite-class PAC bound with $|\mathcal{H}|=2^{20}$, $\delta=0.05$, $n=10^4$. Arithmetic re-verified independently in Python: $\log(2\cdot2^{20}/0.05)\approx17.55$ and the gap $\approx0.0296$, consistent with the stated $\approx0.030$ and the "halve to 1.5% needs roughly 4x data" follow-up.
- [resolved] The "vacuously loose, error > 1" claim (line 304) and the flat-minima PAC-Bayes claim (line 232) are now grounded in dziugaite2017computing.

## Findings (remaining)
- [minor] Correctness and Grounding: def-pac (lines 53 to 57) still states the realizable setting ("for any target concept $c \in \mathcal{H}$") with threshold $P(R(h)\le\epsilon)\ge1-\delta$, while thm-finite-pac and thm-vc-bound are agnostic (they bound $R(h)-\hat{R}(h)$). A one-line note distinguishing realizable from agnostic PAC would make the definition fully consistent with the bounds that follow. Not a gate failure.

## Verdict rationale
Correctness and Grounding (the gate) now passes: every citekey resolves, the spectral bound is correctly attributed and softened, and all numeric claims are verified. The remaining realizable-versus-agnostic note is a minor clarification that does not undermine any stated result. All other dimensions are strong. Verdict: ACCEPT.
