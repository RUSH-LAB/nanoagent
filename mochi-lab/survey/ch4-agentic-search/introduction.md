---
sidebar_position: 1
title: "Introduction & Motivation"
---

## Introduction & Motivation

Traditional information retrieval operates on a simple paradigm: a user formulates a query, a system returns ranked results, and the user evaluates them. This static, one-shot interaction is fundamentally limited for complex information needs that require multi-step reasoning, synthesis across sources, or iterative refinement of understanding [@metzler2021rethinking, @nakano2021webgpt]. A researcher investigating a complex question -- "What are the most promising approaches to carbon capture, and what are their economic viability projections?" -- cannot answer this from a single search query. They must conduct dozens of searches, read and evaluate papers, follow citation chains, cross-reference data from different sources, and synthesize findings into a coherent picture.

Agentic search represents a paradigm shift: instead of returning documents, the system actively pursues answers through multi-step information-seeking strategies. An agentic search system can reformulate queries, follow citation chains, synthesize information from multiple sources, verify claims against evidence, and iteratively refine its understanding -- all autonomously [@singh2025agentic, @wang2024survey]. The distinction between traditional retrieval and agentic search is analogous to the distinction between looking up a word in a dictionary and conducting a research project: the former is a single lookup, the latter is a goal-directed process involving planning, execution, evaluation, and iteration.

The emergence of large language models (LLMs) as capable reasoning engines has made agentic search practically viable. LLMs provide the "brain" that can plan search strategies, interpret results, decide what to search next, and synthesize findings into coherent answers. When augmented with tools -- web search engines, databases, APIs, code executors -- LLMs become search agents that can tackle information needs far beyond the reach of traditional IR systems [@qin2023tool, @schick2023toolformer]. The convergence of four capabilities enables this transformation:

1. **Reasoning and planning.** Modern LLMs can decompose complex questions into sub-questions, identify what information is needed, and plan multi-step search strategies. Chain-of-thought prompting [@wei2022chain], zero-shot reasoning [@kojima2022large], least-to-most decomposition [@zhou2023leasttomost], and self-consistency [@wang2023selfconsistency] have demonstrated that LLMs can perform the kind of structured reasoning needed to navigate complex information landscapes.

2. **Tool use.** LLMs can learn to invoke external tools -- search engines, calculators, code interpreters, databases -- through in-context learning or fine-tuning [@schick2023toolformer, @qin2023tool]. This gives them the ability to interact with the information ecosystem rather than relying solely on their parametric knowledge.

3. **Self-evaluation.** LLMs can assess the quality and relevance of retrieved information, identify gaps in their knowledge, and decide when more evidence is needed. This self-monitoring capability enables adaptive search strategies that respond to the quality of initial results.

4. **Synthesis.** LLMs can combine information from multiple sources into coherent, well-structured answers with proper attribution. This synthesis capability distinguishes agentic search from traditional retrieval, which returns documents rather than answers.

This chapter surveys the landscape of agentic search, from foundational retrieval-augmented generation (RAG) to sophisticated multi-hop reasoning systems, from web browsing agents to search-guided mathematical proof and code generation. We organize the literature by the level of agency: from passive retrieval augmentation (the system retrieves once and generates), through active multi-step search (the system iteratively retrieves and reasons), to fully autonomous search agents (the system plans and executes complex research workflows). Throughout, we emphasize the underlying computational principles -- search as sequential decision-making, the explore-exploit tradeoff in information gathering, and the role of verification in guiding search -- that connect these diverse approaches.
