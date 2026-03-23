---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

## Taxonomy of Approaches

Agentic search methods span a wide spectrum of complexity and autonomy. We organize them by their level of agency and the sophistication of their search strategies:

1. **Tool-Augmented Retrieval:** LLMs that can invoke search tools as part of their generation process (WebGPT [@nakano2021webgpt], Toolformer [@schick2023toolformer], ReAct [@yao2023react]). These represent the simplest form of agentic search: the model decides when to search and formulates queries, but typically performs only one or two search rounds. The key innovation is giving the LLM agency over when and how to search, rather than always retrieving.

2. **Retrieval-Augmented Generation (RAG):** Systems that retrieve relevant documents and condition the LLM's generation on this retrieved context (REALM [@guu2020realm], RAG [@lewis2020rag], RETRO [@borgeaud2022retro], Self-RAG [@asai2024selfrag], GraphRAG [@edge2024graphrag]). RAG systems range from simple single-retrieval pipelines to sophisticated architectures with adaptive retrieval, re-ranking, and self-reflection. The fundamental insight is that retrieval can substitute for parametric scale -- a 7B model with retrieval can match a 175B model without it [@borgeaud2022retro].

3. **Multi-Hop Reasoning Search:** Systems that perform iterative retrieval interleaved with reasoning, combining evidence across multiple search steps (IRCoT [@trivedi2023ircot], FLARE [@jiang2023flare], DSP [@khattab2023dsp], ITER-RETGEN [@shao2023enhancing]). These methods are specifically designed for questions that cannot be answered from a single retrieval step. The compositionality gap [@press2023measuring] -- the gap between single-hop and multi-hop reasoning performance -- motivates this entire family.

4. **Agentic Web Search:** Autonomous agents that browse the web and interact with web interfaces (WebGPT, WebArena [@zhou2024webarena], Mind2Web [@deng2024mind2web]). These agents operate in the full complexity of the web, navigating pages, filling forms, and extracting information from diverse sources. The gap between human performance (~75-90% on these benchmarks) and agent performance (~15-30%) highlights the remaining challenge.

5. **Search with Planning (MCTS + LLMs):** Systems that use tree search and planning algorithms for systematic exploration of solution and reasoning spaces (Tree-of-Thought [@yao2023tree], RAP [@hao2023reasoning], LATS [@zhou2024lats], AlphaProof [@deepmind2024alphaproof]). These methods apply the principled exploration-exploitation framework from game-playing AI to search and reasoning problems. The connection to test-time compute scaling [@snell2024scaling_testtime] suggests that search at inference time can be as valuable as scaling pre-training compute.

6. **Search in Code and Mathematics:** Specialized search systems for domains with verifiable outcomes, including competitive programming (AlphaCode [@li2022alphacode]), software engineering (SWE-Agent [@yang2024sweagent]), and formal theorem proving (AlphaProof, DeepSeek-Prover [@xin2024deepseekprover]). Verifiability enables more effective search through test-based filtering and formal verification. The pass@k metric directly quantifies the value of search: the gap between pass@1 and pass@100 measures how much search budget improves outcomes.

7. **Self-Improving Search and Deep Research:** Systems that conduct comprehensive, autonomous research through multi-turn search and synthesis (STORM [@shao2024storm], OpenAI Deep Research, Perplexity). These represent the most advanced form of agentic search, autonomously planning and executing complex research workflows that would take a human researcher hours or days.

These categories are not mutually exclusive: modern systems often combine elements from multiple categories. For example, a deep research system might use RAG as its retrieval backbone, multi-hop reasoning for evidence synthesis, MCTS for exploring alternative research directions, and tool-augmented retrieval for accessing diverse information sources. The trend is toward increasingly autonomous systems that combine all of these capabilities with minimal human intervention.
