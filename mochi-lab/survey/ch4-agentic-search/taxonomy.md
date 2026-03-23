---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

## Taxonomy of Approaches

Agentic search methods span a wide spectrum of complexity and autonomy. We organize them by their level of agency and the sophistication of their search strategies:

1. **Tool-Augmented Retrieval:** LLMs that can invoke search tools as part of their generation process (WebGPT, Toolformer, ReAct). These represent the simplest form of agentic search: the model decides when to search and formulates queries, but typically performs only one or two search rounds.

2. **Retrieval-Augmented Generation (RAG):** Systems that retrieve relevant documents and condition the LLM's generation on this retrieved context (REALM, RAG, RETRO, Self-RAG, GraphRAG). RAG systems range from simple single-retrieval pipelines to sophisticated architectures with adaptive retrieval, re-ranking, and self-reflection.

3. **Multi-Hop Reasoning Search:** Systems that perform iterative retrieval interleaved with reasoning, combining evidence across multiple search steps (IRCoT, FLARE, DSP, ITER-RETGEN). These methods are specifically designed for questions that cannot be answered from a single retrieval step.

4. **Agentic Web Search:** Autonomous agents that browse the web and interact with web interfaces (WebGPT, WebArena agents, Mind2Web). These agents operate in the full complexity of the web, navigating pages, filling forms, and extracting information from diverse sources.

5. **Search with Planning (MCTS + LLMs):** Systems that use tree search and planning algorithms for systematic exploration of solution and reasoning spaces (Tree-of-Thought, RAP, LATS, AlphaProof). These methods apply the principled exploration-exploitation framework from game-playing AI to search and reasoning problems.

6. **Search in Code and Mathematics:** Specialized search systems for domains with verifiable outcomes, including competitive programming (AlphaCode), software engineering (SWE-Agent), and formal theorem proving (AlphaProof, DeepSeek-Prover). Verifiability enables more effective search through test-based filtering and formal verification.

7. **Self-Improving Search and Deep Research:** Systems that conduct comprehensive, autonomous research through multi-turn search and synthesis (STORM, OpenAI Deep Research, Perplexity). These represent the most advanced form of agentic search, autonomously planning and executing complex research workflows.

These categories are not mutually exclusive: modern systems often combine elements from multiple categories. For example, a deep research system might use RAG as its retrieval backbone, multi-hop reasoning for evidence synthesis, MCTS for exploring alternative research directions, and tool-augmented retrieval for accessing diverse information sources.
