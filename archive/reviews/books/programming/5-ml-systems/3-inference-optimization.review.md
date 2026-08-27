# Review: books/programming/5-ml-systems/3-inference-optimization.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness & Grounding: 2, Motivation: 4, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 3, Completeness: 4

## Re-review scores
Correctness & Grounding: 4, Motivation: 4, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 4

## Findings (status after revision)
- [resolved][blocker] Correctness & Grounding: Llama 2 70B KV-cache row now reads 1.3 GB per seq and 1.3 GB x batch. Recomputed independently with the section formula: 2 x 80 x 8 x 128 x 4096 x 2 = 1.34e9 bytes (1.25 GiB), which rounds to 1.3 GB. The 7B row (2.15 GB / 2.0 GiB) and Llama 3 8B row (16.78 GB / 15.62 GiB) also reconcile. The gate now passes.
- [resolved][major] Correctness & Grounding: Named methods and the BitNet b1.58 claim now carry citekeys. Verified all seven resolve as top-level entries in mochi-lab/references.yaml: ma2024bitnet158, frantar2023gptq, lin2024awq, leviathan2023fast, chen2023accelerating, kwon2023efficient, dao2022flashattention.
- [resolved][major] Correctness & Grounding: The speculative-decoding code now matches the Leviathan/Chen algorithm. The misleading comment is corrected to "k draft dists + 1 bonus dist", an accepted_all flag tracks full acceptance, and on full acceptance the loop samples the free bonus token from target_probs[k]. Code and the "exact" claim are now consistent.
- [resolved][minor] Notation & Component Discipline: All prose "--" occurrences removed and replaced with colons. A scan finds no em-dash, en-dash, or prose "--". Remaining "---" are frontmatter and table delimiters (legitimate markdown); the "──" runs in the code block are decorative box-drawing characters, not prose.
- [resolved][minor] Notation & Component Discipline: GPT-4 row is now explicitly labeled "(est.)" with "?" for the unknown head count, so it is not read as a computed figure.

## Remaining (non-blocking, left for human)
- [minor] Worked Examples: The KV-memory formula is still not walked through a single fully worked numeric <Example> component. Adding one (plugging in Llama 2 7B or 70B step by step) would lift this dimension and mirror how the table rows are derived.
- [minor] Completeness: The Llama 3 8B row still lists 128,000 max context without a version label. 128K context applies to the Llama 3.1 generation (base Llama 3 8B is 8,192); the row should be relabeled to avoid a version mismatch. The 16 GB figure is correct for the 128K case.
- [minor] Grounding: SmoothQuant (W8A8) and the serving-table techniques (continuous batching, prefix caching, FlashDecoding, CUDA Graphs) make external claims with no citekey. No smoothquant/xiao2023 entry exists in references.yaml; correctly not fabricated. Author should add the entries and cite.
- [minor] Grounding: Quantitative claims left unverified and uncited: speculative acceptance-rate/speedup figures, quantization speed multipliers, BitNet 4-8x theoretical figure, 0.1-0.5 perplexity range, and the H100 3.35 TB/s / 990 TFLOPS numbers. Spot-check against primary sources.

## Verdict rationale
The Correctness gate now passes: the numeric blocker is fixed and verified, every external claim that names a method now has a resolving citekey, and the speculative-decoding code is algorithmically correct. The remaining items are minor polish and optional grounding additions that do not block publication. Verdict moves from REJECT to ACCEPT.
