# Paged Memory for Hallucination-Free BibTeX Verification

**Harness:** We develop two components:
- our own `nanoagent` harness
- an interactive web app that manages papers and documentations and supports communications with human and agents

**Task:** Given a BibTeX entry and a question about it, return whether it matches a verified database record plus a summary answering the question with evidence.

**Method:** Two-level paged lookup. Level 1 checks whether the BibTeX is unseen with a Bloom filter; level 2 checks whether the question about that BibTeX was already asked with LSH over question shingles. In the agent loop there are three scenarios:

1. BibTeX seen, question asked: reuse the cached summary with no fetch.
2. BibTeX seen, question new: answer with summary plus evidence, then cache it.
3. BibTeX unseen: flag it for human review, then answer with summary plus evidence once verified.

**Why this saves tokens:** In all cases only the triple of BibTeX, question, and summary stays in context. Full evidence is fetched on demand and *re-evicted*, so it never accumulates in context.

**Expected effect:** (1) No hallucination of BibTeX, (2) ~10x token reduction for summarization, with larger savings as more verdicts accumulate in cache. 

**Potential to be a more general method:** The same `(document, question, answer)` paging generalizes beyond BibTeX to URLs and tool outputs.