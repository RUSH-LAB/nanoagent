# Review: books/survey/ch4-agentic-search/tool-augmented-retrieval.md

- Content type: literature-review
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 11
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 2, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Verification of prior repairs
- Citation Integrity (blocker): RESOLVED. The ToolBench/ToolLLM paragraph now cites @qin2023toolllm, which resolves in references.yaml to "ToolLLM: Facilitating Large Language Models to Master 16000+ Real-world APIs" (the correct paper). The survey citekey @qin2023tool is no longer used here. Figures corrected to 16,464 RapidAPI APIs across 49 categories with the DFSDT tree-search method. In-text year now reads "Qin et al., 2023", matching the bib entry.
- Balance & Currency (major): RESOLVED. The WebGPT "superhuman information synthesis" claim is gone, replaced by the paper's actual preference rates (69% over the top-voted Reddit answer, 56% over human demonstrators for the 175B best-of-64 model) and framed as matching or modestly exceeding human demonstrators.
- Synthesis over Summary (major): RESOLVED. A "Comparing the Families" section with a synthesis table now contrasts WebGPT, Toolformer, ReAct, TALM, Gorilla, and ToolLLM along supervision source, relative training cost, and one-shot vs iterative tool use. The TALM and Function Calling/ToolLLM subsections now close with comparative takeaways.
- Citation Integrity (major): RESOLVED. The Toolformer claim now specifies the win categories (math/reasoning: SVAMP, ASDiv, MAWPS; LAMA-style factual completion) and explicitly notes the open-domain QA shortfall (TriviaQA, WebQuestions, Natural Questions) attributed to the weak built-in search engine.
- Taxonomy/house style (minor): RESOLVED. All 11 prose "--" instances are removed. The only remaining "--" are the YAML frontmatter delimiters (lines 1, 4) and the required markdown table separator (line 50).

## Citekey check
All in-text citekeys resolve in references.yaml: nakano2021webgpt, schick2023toolformer, yao2023react, parisi2022talm, patil2023gorilla, qin2023toolllm. No broken citekeys.

## Remaining issues after repair
- [minor] Problem Formulation & Eval Rigor: "Gorilla achieved significantly better API call accuracy than GPT-4" is still unquantified. Recommend adding the verified figure (Gorilla, 7B LLaMA with Retriever-Aware Training, improves AST accuracy by about 20.4% over GPT-4 across Torch Hub / HuggingFace / TensorFlow Hub) to remove the setting-blind superlative.
- [minor] Citation Integrity: In-text year inconsistency for WebGPT persists. The text reads "Nakano et al. (2022)" while the citekey and references.yaml entry are 2021. Reconcile to 2021.

Both residuals are minor and non-blocking. All blockers and majors from the original review are resolved, the taxonomy gate now passes via the synthesis table, and house-style compliance is met.
