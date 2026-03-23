---
sidebar_position: 2
title: "Problem Formulation"
---

## Problem Formulation

### Search as Sequential Decision-Making

Agentic search can be formalized as a sequential decision-making problem [@sutton2018reinforcement]. At each step t, the agent observes a state s_t (comprising the current query, retrieved information, reasoning context, and history of actions), selects an action a_t from an action space (search query, tool call, reasoning step, or answer generation), and receives an observation o_{t+1} (search results, tool outputs, or verification feedback). The process continues until a termination condition is met (answer found, confidence threshold reached, or budget exhausted).

The objective is to maximize the quality of the final answer while minimizing search cost:

maximize Quality(answer) - lambda * Cost(search_trajectory)

where Cost may include the number of search queries, API calls, tokens processed, wall-clock time, or monetary cost. This formulation connects agentic search to partially observable Markov decision processes (POMDPs), where the "true state" (the answer to the question and the location of relevant evidence in the information landscape) is hidden and must be inferred through observations.

### The Information-Seeking Decision Process

More formally, an agentic search system can be modeled as a tuple (S, A, T, R, gamma) where:

- **S** is the state space, representing the agent's current knowledge (retrieved documents, reasoning chains, partial answers, confidence estimates)
- **A** is the action space, including search queries of different types (keyword, semantic, structured), tool invocations (calculator, code executor, API calls), reasoning operations (decompose, synthesize, verify), and termination (answer with confidence)
- **T: S x A -> S** is the transition function, determined by the environment's response to the agent's actions (search engine results, tool outputs)
- **R: S x A -> R** is the reward function, capturing answer quality, factual accuracy, completeness, and cost
- **gamma** is a discount factor reflecting the urgency of finding an answer (lower gamma favors faster answers)

### Reward Signals

Defining reward signals for agentic search is challenging. Unlike game-playing settings where rewards are well-defined (win/lose, score), search quality is often subjective and multidimensional. Common proxy rewards include:

- **Answer accuracy** on benchmark questions with known ground truth [@gao2023enabling]
- **Faithfulness to retrieved evidence** -- whether generated claims are supported by the cited sources [@liu2023evaluating]
- **Citation quality** -- precision (cited sources actually support claims) and recall (important claims are cited) [@rashkin2023measuring]
- **Completeness** -- whether the answer covers all aspects of the question
- **User satisfaction ratings** -- direct human evaluation, which captures aspects that automatic metrics miss

The reward design problem is further complicated by the **delayed reward** structure: the quality of the final answer depends on the entire search trajectory, but individual search actions may not have clear immediate rewards. This motivates the use of process reward models (PRMs) that can evaluate intermediate search steps, not just final outcomes [@lightman2023prm].

### Key Challenges

Agentic search must address several fundamental challenges:

- **When to search (retrieval necessity).** Not all questions require retrieval; the agent must decide when its parametric knowledge is sufficient vs. when external evidence is needed. Searching when unnecessary wastes compute; failing to search when needed produces hallucinated answers. Adaptive retrieval methods like Self-RAG [@asai2024selfrag] and FLARE [@jiang2023flare] address this by learning when retrieval is beneficial.

- **What to search for (query formulation).** Query formulation is critical -- the same information need can be expressed as many different queries with vastly different retrieval results. The gap between the user's information need and the optimal search query (the "vocabulary mismatch" problem from classical IR) is exacerbated in multi-hop settings where the needed information is not directly stated in the original question.

- **When to stop (stopping criterion).** The agent must balance thoroughness against cost, deciding when enough evidence has been gathered. Too little search produces incomplete answers; too much search wastes resources and can introduce noise or contradictory information. This is an instance of the **optimal stopping problem** from decision theory [@ferguson2006optimal].

- **How to synthesize (information fusion).** Combining information from multiple, potentially contradictory sources into a coherent, faithful answer is a fundamental challenge. The system must handle varying source quality, resolve contradictions, maintain provenance (which claims come from which sources), and avoid introducing information not present in any source.

- **How to verify (factual grounding).** Ensuring that generated claims are grounded in retrieved evidence, and that the retrieved evidence itself is reliable, requires verification mechanisms. This connects to the broader challenge of LLM truthfulness and the development of verification systems.
