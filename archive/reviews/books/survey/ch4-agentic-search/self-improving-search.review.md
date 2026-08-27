# Review: books/survey/ch4-agentic-search/self-improving-search.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 3, Taxonomy Quality: 3, Synthesis over Summary: 2, Citation Integrity: 2, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 2

## Re-review scores
Scope and Coverage Completeness: 3, Taxonomy Quality: 3, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 4

## Findings
- [resolved] Citation Integrity: The IRCoT claim now reads "improves multi-hop QA F1 by roughly 5 to 9 points on HotpotQA and MuSiQue (and up to 15 points on 2WikiMultihopQA) over single-pass retrieval" (line 24). This matches the ACL 2023 paper: metric is F1, expressed in points not percent, and the up-to-15 figure is correctly attributed to 2WikiMultihopQA. The earlier inflated "15-20% accuracy" overclaim is gone.
- [resolved] Citation Integrity: The unsupported "STORM 2" sentence was removed. No dangling reference remains; shao2024storm is the only STORM citation and it is used correctly.
- [resolved] Synthesis over Summary: Each previously annotated-bibliography subsection now ends with a comparative takeaway. Deep Research (line 20) contrasts Gemini's editable plan checkpoint against OpenAI's more autonomous execution. Autonomous Agent Frameworks (line 38) names the generality vs control vs coordination-overhead tradeoff across Auto-GPT, LangChain/LlamaIndex, and AutoGen/CrewAI. AI-Powered Search Engines (line 48) contrasts Perplexity search-first grounding against ChatGPT Search conversation-first latency.
- [resolved] Problem Formulation and Evaluation Rigor: The STORM evaluation now names the instrument (rubric-based human eval on FreshWiki, experienced Wikipedia editors) and flags the depth finding as qualitative (line 10). The "most capable" superlative was softened to "among the more capable deployed instantiations" and tied to named benchmarks BrowseComp and GAIA (line 16).
- [resolved] House style: All three prose "--" occurrences (lines 16, 34) are gone; only the YAML frontmatter delimiters remain. Verified by content search.
- [minor] Balance and Currency: Product claims for OpenAI Deep Research, Google Gemini Deep Research, Perplexity, SearchGPT/ChatGPT Search, LangChain, LlamaIndex, and CrewAI remain uncited (no system card, technical report, or product URL). For a survey these are still blog-grade in traceability. Not blocking, but anchoring each to a primary source would lift the Currency score.
- [minor] Balance and Currency: The LangChain/LlamaIndex passage (line 36) is now better balanced by the line 38 tradeoff sentence, but the specific critique requested in the prior review (abstraction overhead, debugging opacity) was not added. Optional polish.
- [minor] Scope and Coverage: No dedicated evaluation/benchmark subsection ties the families together; benchmarks (BrowseComp, GAIA, FreshWiki) appear only inline. A short cross-cutting eval paragraph would raise Scope and Coverage.

## Verdict rationale
All four major findings from the original REVISE (IRCoT overclaim, unsupported STORM-2 sentence, annotated-bibliography subsections, setting-blind superlative and metric-free eval claims) are resolved, and the house-style dash violations are cleared. All ten citekeys resolve to exact top-level entries in references.yaml. Remaining items are minor currency and coverage polish that do not block publication. Verdict moves from REVISE to ACCEPT.

## Remaining issues after repair
- Product systems (Deep Research variants, Perplexity, ChatGPT Search, LangChain, LlamaIndex, CrewAI) lack primary-source citations; anchor to system cards or official announcements when available.
- LangChain/LlamaIndex critique (abstraction overhead, debugging opacity) still not added; family treatment is even but could be sharper.
- No consolidated benchmark/eval subsection; BrowseComp, GAIA, and FreshWiki are referenced only inline.
