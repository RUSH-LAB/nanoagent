---
sidebar_position: 2
title: "Problem Formulation"
---

## Problem Formulation

### Search as Sequential Decision-Making

Agentic search can be formalized as a sequential decision-making problem [@sutton2018reinforcement]. At each step t, the agent observes a state s_t (comprising the current query, retrieved information, reasoning context, and history of actions), selects an action a_t from an action space (search query, tool call, reasoning step, or answer generation), and receives an observation o_{t+1} (search results, tool outputs, or verification feedback). The process continues until a termination condition is met (answer found, confidence threshold reached, or budget exhausted). This formalization connects to the POMDP framework in world models (Chapter 2) and the tree search methods in MCTS-based reasoning (Section 4.6).

The analogy to reinforcement learning is precise but illuminating in its differences. Unlike Atari games or robotic control where the environment dynamics are stationary and (in principle) fully observable, the information environment of agentic search is vast, partially observable, non-stationary (web content changes), and adversarial (SEO manipulation, misinformation). The state space is combinatorially large: the set of all possible combinations of retrieved documents, reasoning chains, and partial answers is astronomical. The action space is equally large: the agent can issue any natural language query, invoke any available tool with any parameters, or produce any reasoning step. This high-dimensional, open-ended nature of the search problem is what makes it fundamentally harder than classical RL benchmarks. As of 2024, most approaches relied on LLMs' emergent planning capabilities rather than explicit RL training, though a 2025 line of work began training search agents end-to-end with reinforcement learning, including Search-R1 [@jin2025searchr1] and R1-Searcher [@song2025r1searcher].

The objective is to maximize the quality of the final answer while minimizing search cost:

maximize Quality(answer) - lambda * Cost(search_trajectory)

where Cost may include the number of search queries, API calls, tokens processed, wall-clock time, or monetary cost. This formulation connects agentic search to partially observable Markov decision processes (POMDPs), where the "true state" (the answer to the question and the location of relevant evidence in the information landscape) is hidden and must be inferred through observations.

### The Information-Seeking Decision Process

More formally, an agentic search system can be modeled as a tuple (S, A, T, R, gamma) where:

- **S** is the state space, representing the agent's current knowledge (retrieved documents, reasoning chains, partial answers, confidence estimates)
- **A** is the action space, including search queries of different types (keyword, semantic, structured), tool invocations (calculator, code executor, API calls), reasoning operations (decompose, synthesize, verify), and termination (answer with confidence)
- **T: S x A -> S** is the transition function, determined by the environment's response to the agent's actions (search engine results, tool outputs)
- **R: S x A -> R** is the reward function, capturing answer quality, factual accuracy, completeness, and cost (specific methods instantiate R differently, e.g., as retrieval necessity scores, citation quality metrics, or user satisfaction)
- **gamma** is a discount factor reflecting the urgency of finding an answer (lower gamma favors faster answers; rarely tuned in practice since most systems use greedy search)

This tuple is not just a formalism: method families differ chiefly in how they instantiate R. Adaptive-retrieval methods such as Self-RAG [@asai2024selfrag] effectively fold a retrieval-necessity signal into R, faithfulness-oriented systems weight citation precision and recall [@rashkin2023measuring], and RL-trained agents such as Search-R1 [@jin2025searchr1] optimize an outcome reward on benchmark answers. Because most systems set gamma close to 1 and search greedily, the design space is dominated by the choice of R far more than by the discount factor.

### Reward Signals

Defining reward signals for agentic search is challenging. Unlike game-playing settings where rewards are well-defined (win/lose, score), search quality is often subjective and multidimensional. Common proxy rewards include:

- **Answer accuracy** on benchmark questions with known ground truth [@gao2023enabling]
- **Faithfulness to retrieved evidence**: whether generated claims are supported by the cited sources [@liu2023evaluating]
- **Citation quality**: precision (cited sources actually support claims) and recall (important claims are cited) [@rashkin2023measuring]
- **Completeness**: whether the answer covers all aspects of the question (commonly used but not standardized)
- **User satisfaction ratings**: direct human evaluation, which captures aspects that automatic metrics miss (commonly used but not standardized)

The reward design problem is further complicated by the **delayed reward** structure: the quality of the final answer depends on the entire search trajectory, but individual search actions may not have clear immediate rewards. This motivates the use of process reward models (PRMs), a concept introduced for math reasoning to supervise intermediate steps rather than only final outcomes [@lightman2023prm]. Applying PRMs to score intermediate search actions is a natural extrapolation of this idea rather than a result established in that work.

### Key Challenges

Agentic search must address several fundamental challenges:

- **When to search (retrieval necessity).** Not all questions require retrieval; the agent must decide when its parametric knowledge is sufficient vs. when external evidence is needed. Searching when unnecessary wastes compute; failing to search when needed produces hallucinated answers. Adaptive retrieval methods like Self-RAG [@asai2024selfrag] and FLARE [@jiang2023flare] address this by learning when retrieval is beneficial.

- **What to search for (query formulation).** Query formulation is critical, since the same information need can be expressed as many different queries with vastly different retrieval results. The gap between the user's information need and the optimal search query (the "vocabulary mismatch" problem from classical IR) is exacerbated in multi-hop settings where the needed information is not directly stated in the original question.

- **When to stop (stopping criterion).** The agent must balance thoroughness against cost, deciding when enough evidence has been gathered. Too little search produces incomplete answers; too much search wastes resources and can introduce noise or contradictory information. This is an instance of the **optimal stopping problem** from decision theory [@ferguson2006optimal].

- **How to synthesize (information fusion).** Combining information from multiple, potentially contradictory sources into a coherent, faithful answer is a fundamental challenge. The system must handle varying source quality, resolve contradictions, maintain provenance (which claims come from which sources), and avoid introducing information not present in any source.

- **How to verify (factual grounding).** Ensuring that generated claims are grounded in retrieved evidence, and that the retrieved evidence itself is reliable, requires verification mechanisms. This connects to the broader challenge of LLM truthfulness and the development of verification systems. FActScore [@min2023factscore] decomposes long-form generations into atomic facts and verifies each against a knowledge source, providing a principled methodology for measuring factual precision. SAFE (Search-Augmented Factuality Evaluator) extends this by using search engines to verify individual claims automatically, reporting roughly 72% agreement with crowdsourced human annotators and winning 76% of a 100-case disagreement subset adjudicated by researchers with full internet access [@wei2024longform]. The verification challenge is compounded in multi-hop settings: a claim synthesized from two correct sources may itself be incorrect if the synthesis introduces an unwarranted inference, and detecting such compositional hallucinations requires reasoning about the logical relationship between source passages and generated claims.

### Complexity and Computational Considerations

The computational complexity of agentic search deserves formal treatment. As an illustrative estimate (these systems do not publish per-query operational figures), a single query to a deep research system may trigger on the order of tens to hundreds of search API calls, each returning several results that must be read and evaluated, processing millions of tokens through the LLM. The total cost scales as O(B * (C_search + K * C_read + C_reason)) per research session, where B is the number of search iterations, K is the number of results processed per search, C_search is the cost of a search API call, C_read is the cost of processing a retrieved document, and C_reason is the cost of the LLM reasoning step. As a back-of-envelope estimate, a deep research query with B=100 iterations, K=5 results per iteration, and 4K tokens per document consumes on the order of 2 million input tokens (100 x 5 x 4K) plus tens of thousands of output tokens, which at frontier-model API prices of a few dollars per million input tokens implies a cost of roughly several dollars per query.

This cost structure creates a fundamental design tension. Shallow search (low B) is cheap but produces incomplete answers for complex questions. Deep search (high B) is thorough but expensive and can introduce noise from marginally relevant results. The optimal search depth depends on the complexity of the question, the quality of initial results, and the user's tolerance for cost versus completeness, motivating the development of adaptive systems that allocate search budget dynamically based on question difficulty [@jeong2024adaptive].
