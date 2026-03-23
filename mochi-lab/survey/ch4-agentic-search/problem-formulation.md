---
sidebar_position: 2
title: "Problem Formulation"
---

## Problem Formulation

### Search as Sequential Decision-Making

Agentic search can be formalized as a sequential decision-making problem [@sutton2018reinforcement]. At each step t, the agent observes a state s_t (comprising the current query, retrieved information, reasoning context, and history of actions), selects an action a_t from an action space (search query, tool call, reasoning step, or answer generation), and receives an observation o_{t+1} (search results, tool outputs, or verification feedback). The process continues until a termination condition is met (answer found, confidence threshold reached, or budget exhausted). This formalization connects to the POMDP framework in world models (Chapter 2) and the tree search methods in MCTS-based reasoning (Section 4.6).

The analogy to reinforcement learning is precise but illuminating in its differences. Unlike Atari games or robotic control where the environment dynamics are stationary and (in principle) fully observable, the information environment of agentic search is vast, partially observable, non-stationary (web content changes), and adversarial (SEO manipulation, misinformation). The state space is combinatorially large: the set of all possible combinations of retrieved documents, reasoning chains, and partial answers is astronomical. The action space is equally large: the agent can issue any natural language query, invoke any available tool with any parameters, or produce any reasoning step. This high-dimensional, open-ended nature of the search problem is what makes it fundamentally harder than classical RL benchmarks, and why most current approaches rely on LLMs' emergent planning capabilities rather than explicit RL training.

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

- **How to verify (factual grounding).** Ensuring that generated claims are grounded in retrieved evidence, and that the retrieved evidence itself is reliable, requires verification mechanisms. This connects to the broader challenge of LLM truthfulness and the development of verification systems. FActScore [@min2023factscore] decomposes long-form generations into atomic facts and verifies each against a knowledge source, providing a principled methodology for measuring factual precision. SAFE (Search-Augmented Factuality Evaluator) extends this by using search engines to verify individual claims automatically, achieving superhuman agreement with human annotations on factuality judgments. The verification challenge is compounded in multi-hop settings: a claim synthesized from two correct sources may itself be incorrect if the synthesis introduces an unwarranted inference, and detecting such compositional hallucinations requires reasoning about the logical relationship between source passages and generated claims.

### Complexity and Computational Considerations

The computational complexity of agentic search deserves formal treatment. A single query to a deep research system like OpenAI Deep Research may trigger 50-200 search API calls, each returning 10 results that must be read and evaluated, processing millions of tokens through the LLM. The total cost scales as O(B * (C_search + K * C_read + C_reason)) per research session, where B is the number of search iterations, K is the number of results processed per search, C_search is the cost of a search API call, C_read is the cost of processing a retrieved document, and C_reason is the cost of the LLM reasoning step. For a typical deep research query with B=100 iterations, K=5 results per iteration, and 4K tokens per document, the total token consumption can exceed 2 million input tokens and 50K output tokens -- costing several dollars per query at current API prices.

This cost structure creates a fundamental design tension. Shallow search (low B) is cheap but produces incomplete answers for complex questions. Deep search (high B) is thorough but expensive and can introduce noise from marginally relevant results. The optimal search depth depends on the complexity of the question, the quality of initial results, and the user's tolerance for cost versus completeness -- motivating the development of adaptive systems that allocate search budget dynamically based on question difficulty [@jeong2024adaptive].
