# Review: books/survey/ch4-agentic-search/agentic-web-search.md

- Content type: literature-review
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 3, Taxonomy Quality: 2, Synthesis over Summary: 2, Citation Integrity: 5, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 2

## Findings
- [resolved] Taxonomy Quality (gate): The flat one-heading-per-benchmark list is gone. The chapter now organizes benchmarks under a single environment axis (Simulated Web Environments, Real-Web Environments, Full-Computer Environments) plus a cross-cutting Agent Architectures section, each family opening with a stated principle and tradeoff, and closing with a Comparative Analysis that reads the families as one progression. Gate is cleared; Taxonomy Quality now 4.
- [resolved] Problem Formulation and Evaluation Rigor: A "Problem Formulation and Scope" section formalizes the agentic-browsing setting as a partially observable sequential decision process (observation, action, state, success), and a benchmark table groups WebArena, VisualWebArena, Mind2Web, GAIA, OSWorld, and AgentBench by environment, task count, observation modality, and human-versus-agent gap. Now 4.
- [resolved] Scope and Coverage Completeness: An explicit in/out-of-scope boundary is stated (covers operating a rendered interface; excludes RAG in Section 4.3 and pure API tool use in Section 4.4), with the boundary defined by observation modality. Coverage is now auditable. Now 4.
- [resolved] Synthesis over Summary: Each subsection now ends on a comparative takeaway that names a tension (WebArena controllability-vs-realism, VisualWebArena text-DOM-vs-vision, Mind2Web reproducibility-vs-fidelity, GAIA ~15% convergence with WebArena, OSWorld near-constant gap). The annotated-bibliography pattern is largely replaced by synthesis. Now 4.
- [resolved] Citation Integrity: The ~15% WebArena figure is corrected to the verified 14.41% / 78.24%, and OSWorld to 12.24% / 72.36%. All 11 citekeys resolve against references.yaml. Stays 5.
- [minor, open] Taxonomy Quality: The benchmark is still written "OS-World" (and "OSWorld" only in the table), but the cited paper title in references.yaml is "OSWorld". Three "OS-World" spellings on lines 81 and 83 should be normalized to "OSWorld" to match the source. This is a naming-consistency nit, not a gate failure.
- [minor, open] Balance and Currency: The o1 claim appended to the AgentBench paragraph (line 87) still lacks a concrete agentic-benchmark number tying o1 to any benchmark discussed, and no cost/latency limitation is noted. The closing Comparative Analysis now contextualizes o1 as moving the needle on long-horizon planning, which softens the one-sidedness, but the body claim itself remains ungrounded by a number.

## Changes made
None by this reviewer. This is an independent re-review of the already-revised file; the substantive restructuring (taxonomy, problem formulation, scope, table, comparative takeaways, corrected figures) was performed in the prior revision and is confirmed present and correct.

## Left for human
- Table entries for VisualWebArena (~910 tasks), Mind2Web (n/a human baseline), GAIA (~466 tasks), and AgentBench (n/a task count) are approximate or n/a; verify against the original papers before publishing. WebArena is listed as ~812 tasks in the table; confirm this against the WebArena paper.
- The derived gap figures in the Comparative Analysis ("roughly 64 points", "60 on OSWorld", "77 on GAIA") are arithmetic from the verified pairs (78.24-14.41, 72.36-12.24, 92-15); double-check the rounding and phrasing.

## Remaining issues after repair
- "OS-World" spelling should be normalized to "OSWorld" (3 occurrences) to match the cited paper.
- The o1 sentence on line 87 should be grounded with a concrete agentic result or moved to a forward-looking note with a stated limitation.

Both remaining items are minor polish/grounding fixes, not gate failures. The taxonomy gate is cleared and the structural blockers are resolved, so the verdict moves from REJECT to REVISE.
