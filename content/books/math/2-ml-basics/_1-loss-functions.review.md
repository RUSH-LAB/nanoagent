# Review: books/math/2-ml-basics/1-loss-functions.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 8
- Broken citekeys: ["radford2021clip","chen2020simclr","oord2018representation","szegedy2016rethinking"]

## Original scores
Correctness & Grounding: 2, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 3, Completeness: 4

## Re-review scores
Correctness & Grounding: 5, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 4

## Findings
- [resolved] Correctness & Grounding: All five previously-broken citekeys now resolve in references.yaml. radford2021clip (CLIP, ICML 2021, arXiv:2103.00020), chen2020simclr (SimCLR, ICML 2020, arXiv:2002.05709), and szegedy2016rethinking (Rethinking the Inception Architecture, CVPR 2016, arXiv:1512.00567) were added as new entries with correct metadata. The broken [@oord2018representation] was corrected to the existing [@oord2018infonce]. Verified each key appears exactly once at top level (no duplicate-key collisions from concurrent edits). The grounding gate now passes.
- [verified] Correctness: Spot-checked the load-bearing math. The InfoNCE lower bound L_InfoNCE >= -I(X;X+) + log K correctly rearranges Oord et al. The softmax cross-entropy gradient (y_hat_k minus indicator) is correct. The univariate and multivariate Gaussian KL closed forms are correct. The MSE-as-Gaussian-MLE remark is correct.
- [resolved] Notation & Component Discipline: The two prose em-dash instances were fixed. "Kullback-Leibler" now uses a single hyphen in both the Definition name attribute (line 65) and body text (line 66). The 6 remaining "--" occurrences are required syntax (frontmatter delimiters lines 1/3; Markdown table separator rows lines 94, 143, 186, 207) and are not prose.
- [minor, open] Notation & Component Discipline: Line 119 re-binds p as the encoder posterior and q as the fixed prior N(0,I) for the VAE example, inverting the chapter Notation Summary (p = true/data distribution, q = model/predicted distribution). It is locally self-consistent but not flagged as a re-binding, which can confuse readers about which direction of KL the VAE minimizes. Non-blocking polish.
- [minor, open] Notation & Component Discipline: Line 212 describes D_KL(p || q) as "KL divergence from q to p", the less common phrasing convention. It is internally consistent with the body text (line 33), but stating the convention explicitly would help readers who read the first argument as the "from" distribution. Non-blocking polish.

## Changes made (by prior pass, confirmed)
The prior revision fixed all blockers in 1-loss-functions.md and references.yaml: corrected [@oord2018representation] to [@oord2018infonce], changed "Kullback--Leibler" to "Kullback-Leibler" in the Definition name and body, and appended verifiable bibliography entries for CLIP, SimCLR, and the Szegedy Inception paper. I independently confirmed all citekeys resolve, the new YAML entries are well-formed and match the existing schema, and no duplicate keys exist.

## Left for human
- A human may wish to double-check the arXiv IDs and author lists for the three new references against canonical sources before publishing; they appear correct on inspection.
- references.yaml was reported as edited concurrently during the prior session; I verified the four relevant keys each appear exactly once, so no merge artifacts are present for these entries.

## Remaining issues after repair
- Two minor, non-blocking notation items remain (the VAE p/q re-binding on line 119 and the "from q to p" phrasing on line 212). Both are internally consistent and optional polish; they do not block acceptance.
