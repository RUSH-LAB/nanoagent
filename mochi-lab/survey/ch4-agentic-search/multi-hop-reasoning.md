---
sidebar_position: 6
title: "Multi-Hop Reasoning Search"
---

## Multi-Hop Reasoning Search

Many complex questions require combining information from multiple sources through multi-step reasoning. A question like "Which university did the inventor of the attention mechanism attend for their PhD?" requires: (1) identifying who invented the attention mechanism, (2) finding which university they attended for their PhD. No single document contains both pieces of information; the system must chain together evidence from multiple retrieval steps. Multi-hop reasoning search methods interleave retrieval with reasoning to solve such questions.

### IRCoT: Interleaving Retrieval with Chain-of-Thought

Trivedi et al. (2023) [@trivedi2023ircot] proposed IRCoT (Interleaving Retrieval with Chain-of-Thought reasoning), which alternates between chain-of-thought reasoning steps and retrieval queries. After each reasoning step, the model generates a targeted search query based on what information it needs next, retrieves relevant passages, and incorporates them into the next reasoning step. This interleaving is critical: unlike one-shot retrieval (which must anticipate all needed information in a single query), IRCoT can formulate increasingly targeted queries as its understanding deepens.

IRCoT demonstrated significant improvements over one-shot retrieval on multi-hop question-answering benchmarks: on HotpotQA, IRCoT improved F1 by 15+ points over one-shot RAG, and on 2WikiMultiHopQA, the improvement was even larger. The key insight is that the quality of retrieval queries improves dramatically when informed by intermediate reasoning -- the model asks better questions when it already knows part of the answer.

### FLARE: Forward-Looking Active Retrieval

Jiang et al. (2023) [@jiang2023flare] proposed FLARE (Forward-Looking Active REtrieval), which triggers retrieval only when the model's confidence drops during generation. FLARE monitors the probability of generated tokens, and when confidence falls below a threshold (indicating the model is uncertain about what it is generating), it uses the generated low-confidence tokens as a query to retrieve supporting evidence. This "active" retrieval strategy avoids unnecessary searches (when the model is confident in its parametric knowledge) while ensuring retrieval happens precisely when the model needs external support.

FLARE's confidence-based triggering is a principled approach to the "when to search" problem: rather than always retrieving or following a fixed schedule, the model's own uncertainty signal determines when retrieval is needed. This is both more efficient (fewer retrieval calls) and more effective (retrieval happens exactly when it is needed) than fixed retrieval strategies.

### DSP: Demonstrate-Search-Predict

Khattab et al. (2023) [@khattab2023dsp] proposed DSP (Demonstrate-Search-Predict), a framework that decomposes knowledge-intensive tasks into three stages: (1) **Demonstrate** -- generate demonstrations of intermediate reasoning steps, (2) **Search** -- use these intermediate results as queries to retrieve supporting evidence, and (3) **Predict** -- combine the demonstrations and retrieved evidence to produce the final answer. DSP introduced the concept of **compiled prompts** that are automatically optimized (via DSPy) to work effectively with specific retrievers and language models.

**DSPy** [@khattab2024dspy] generalized DSP into a programming framework for building modular retrieval-augmented systems. DSPy treats prompt engineering as a programming problem: users define the modules and their connections (the "program"), and DSPy's optimizers automatically learn the prompts and few-shot examples that maximize performance on a given metric. This abstraction has been influential in the RAG community, shifting focus from manual prompt engineering to systematic optimization of retrieval-augmented pipelines.

### ITER-RETGEN: Iterative Retrieval-Generation

Shao et al. (2023) [@shao2023enhancing] proposed ITER-RETGEN, which implements an iterative loop of retrieval and generation: the model generates an initial answer, uses this answer to formulate new retrieval queries (which are more focused than the original question), retrieves additional evidence, and regenerates the answer incorporating the new evidence. This process repeats for a fixed number of iterations. ITER-RETGEN demonstrated that even simple iterative retrieval (without sophisticated reasoning or planning) substantially improves answer quality on multi-hop questions.

### In-Context Retrieval-Augmented LMs

Ram et al. (2023) [@ram2023incontext] demonstrated that simply prepending retrieved passages to the LLM's input (in-context RAG) can be surprisingly effective for knowledge-intensive tasks when the retrieval is high-quality and the LLM has sufficient context length. This "retrieve and read" paradigm serves as a strong baseline that more complex multi-hop approaches must beat, and highlights that much of the value of RAG comes from retrieval quality rather than architectural complexity.

### Adaptive Retrieval Strategies

More recent work has explored **learned policies** for deciding when, what, and how to retrieve:

**Retrieval-augmented fine-tuning with RL:** Feng et al. (2024) [@feng2024retrieval] trained retrieval policies using reinforcement learning, where the agent learns to decide at each generation step whether to retrieve, what query to issue, and which retrieved passages to incorporate. The RL-trained policy outperforms both always-retrieve and heuristic-based retrieval strategies, suggesting that the retrieval decision itself is a learnable skill.

**Adaptive-RAG** (Jeong et al., 2024) [@jeong2024adaptive] classifies incoming queries into complexity levels and routes them to different retrieval strategies: simple questions go through single-step retrieval, moderate questions use multi-step retrieval, and complex questions trigger iterative search with reasoning. This routing approach matches retrieval effort to question difficulty, improving both efficiency and quality.

### The Multi-Hop Reasoning Gap

Despite significant progress, there remains a substantial gap between current multi-hop retrieval systems and human-level multi-hop reasoning. Press et al. (2023) [@press2023measuring] formally measured this "compositionality gap" -- the fraction of multi-hop questions that a model answers incorrectly despite answering all constituent sub-questions correctly -- and found it to be substantial even in frontier models. StrategyQA (Geva et al., 2021) [@geva2023strategyqa] demonstrated that questions requiring implicit multi-step reasoning strategies (where the decomposition is not obvious from the question text) are particularly challenging. Current systems struggle with: (1) questions requiring more than 3-4 hops, where error accumulates across reasoning steps; (2) questions requiring numerical reasoning or comparison across retrieved evidence; (3) questions where the relevant evidence is spread across many documents with varying quality; and (4) questions requiring common-sense reasoning to bridge gaps between retrieved facts. Closing this gap likely requires advances in both retrieval (finding the right evidence) and reasoning (combining evidence correctly).
