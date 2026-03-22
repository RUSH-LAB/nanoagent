---
sidebar_position: 1
title: "Introduction & Motivation"
---

## Introduction & Motivation

Traditional information retrieval operates on a simple paradigm: a user formulates a query, a system returns ranked results, and the user evaluates them. This static, one-shot interaction is fundamentally limited for complex information needs that require multi-step reasoning, synthesis across sources, or iterative refinement of understanding [@metzler2021rethinking, @nakano2021webgpt].

Agentic search represents a paradigm shift: instead of returning documents, the system actively pursues answers through multi-step information-seeking strategies. An agentic search system can reformulate queries, follow citation chains, synthesize information from multiple sources, verify claims against evidence, and iteratively refine its understanding -- all autonomously [@singh2025agentic, @wang2024survey].

The emergence of large language models (LLMs) as capable reasoning engines has made agentic search practically viable. LLMs provide the "brain" that can plan search strategies, interpret results, decide what to search next, and synthesize findings into coherent answers. When augmented with tools -- web search engines, databases, APIs, code executors -- LLMs become search agents that can tackle information needs far beyond the reach of traditional IR systems [@qin2023tool, @schick2023toolformer].

This chapter surveys the landscape of agentic search, from foundational retrieval-augmented generation (RAG) to sophisticated multi-hop reasoning systems, from web browsing agents to search-guided mathematical proof. We organize the literature by the level of agency: from passive retrieval augmentation, through active multi-step search, to fully autonomous search agents.
