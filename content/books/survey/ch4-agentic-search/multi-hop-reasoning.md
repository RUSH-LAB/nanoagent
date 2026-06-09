---
sidebar_position: 6
title: "Multi-Hop Reasoning Search"
---

## Multi-Hop Reasoning Search

Many complex questions require combining information from multiple sources through multi-step reasoning. A question like "Which university did the inventor of the attention mechanism attend for their PhD?" requires: (1) identifying who invented the attention mechanism, (2) finding which university they attended for their PhD. No single document contains both pieces of information; the system must chain together evidence from multiple retrieval steps. Multi-hop reasoning search methods interleave retrieval with reasoning to solve such questions.

### IRCoT: Interleaving Retrieval with Chain-of-Thought

Trivedi et al. (2023) [@trivedi2023ircot] proposed IRCoT (Interleaving Retrieval with Chain-of-Thought reasoning), which alternates between chain-of-thought reasoning steps and retrieval queries. After each reasoning step, the model generates a targeted search query based on what information it needs next, retrieves relevant passages, and incorporates them into the next reasoning step. This interleaving is critical: unlike one-shot retrieval (which must anticipate all needed information in a single query), IRCoT can formulate increasingly targeted queries as its understanding deepens.

IRCoT demonstrated consistent improvements over one-shot retrieval on multi-hop question-answering benchmarks. On HotpotQA (a two-hop question-answering benchmark over Wikipedia paragraphs), IRCoT improved Answer-F1 over the one-step (OneR) baseline by 9.4 points with Flan-T5-XXL and 7.1 points with GPT-3, with comparable or larger gains on the other datasets the authors evaluate, which include 2WikiMultiHopQA (multi-hop questions whose reasoning chains are built from Wikipedia and Wikidata). The largest single-dataset Answer-F1 gain the paper reports is roughly 15 points. The key insight is that the quality of retrieval queries improves dramatically when informed by intermediate reasoning: the model asks better questions when it already knows part of the answer.

These gains illustrate the core trade-off of step-wise retrieval: interleaving reasoning and retrieval raises answer quality at the cost of more retrieval calls per question than one-shot RAG.

### FLARE: Forward-Looking Active Retrieval

Jiang et al. (2023) [@jiang2023flare] proposed FLARE (Forward-Looking Active REtrieval), which triggers retrieval only when the model's confidence drops during generation. FLARE monitors the probability of generated tokens, and when confidence falls below a threshold (indicating the model is uncertain about what it is generating), it uses the generated low-confidence tokens as a query to retrieve supporting evidence. This "active" retrieval strategy avoids unnecessary searches (when the model is confident in its parametric knowledge) while ensuring retrieval happens precisely when the model needs external support.

FLARE's confidence-based triggering is a principled approach to the "when to search" problem: rather than always retrieving or following a fixed schedule, the model's own uncertainty signal determines when retrieval is needed. This is both more efficient (fewer retrieval calls) and more effective (retrieval happens exactly when it is needed) than fixed retrieval strategies. Whereas IRCoT retrieves at every reasoning step, FLARE retrieves only when confidence drops, making its hop count depend on model uncertainty rather than reasoning structure.

### DSP: Demonstrate-Search-Predict

Khattab et al. (2023) [@khattab2023dsp] proposed DSP (Demonstrate-Search-Predict), a framework that decomposes knowledge-intensive tasks into three stages: (1) **Demonstrate**, generating demonstrations of intermediate reasoning steps, (2) **Search**, using these intermediate results as queries to retrieve supporting evidence, and (3) **Predict**, combining the demonstrations and retrieved evidence to produce the final answer. DSP introduced the concept of **compiled prompts** that are automatically optimized (via DSPy) to work effectively with specific retrievers and language models.

**DSPy** [@khattab2024dspy] generalized DSP into a programming framework for building modular retrieval-augmented systems. DSPy treats prompt engineering as a programming problem: users define the modules and their connections (the "program"), and DSPy's optimizers automatically learn the prompts and few-shot examples that maximize performance on a given metric. This abstraction has been influential in the RAG community, shifting focus from manual prompt engineering to systematic optimization of retrieval-augmented pipelines.

### ITER-RETGEN: Iterative Retrieval-Generation

Shao et al. (2023) [@shao2023enhancing] proposed ITER-RETGEN, which implements an iterative loop of retrieval and generation: the model generates an initial answer, uses this answer to formulate new retrieval queries (which are more focused than the original question), retrieves additional evidence, and regenerates the answer incorporating the new evidence. This process repeats for a fixed number of iterations. ITER-RETGEN demonstrated that even simple iterative retrieval (without sophisticated reasoning or planning) substantially improves answer quality on multi-hop questions. Unlike IRCoT's step-wise retrieval and FLARE's confidence-triggered retrieval, ITER-RETGEN runs for a fixed number of iterations, trading adaptivity for simplicity.

### In-Context Retrieval-Augmented LMs

Ram et al. (2023) [@ram2023incontext] demonstrated that simply prepending retrieved passages to the LLM's input (in-context RAG) can be surprisingly effective for knowledge-intensive tasks when the retrieval is high-quality and the LLM has sufficient context length. This "retrieve and read" paradigm serves as a strong baseline that more complex multi-hop approaches must beat, and highlights that much of the value of RAG comes from retrieval quality rather than architectural complexity.

### Adaptive Retrieval Strategies

More recent work has explored adaptive strategies for deciding when, what, and how to retrieve:

**Retrieval-generation synergy (ITRG):** Feng et al. (2024) [@feng2024retrieval] proposed an iterative loop that alternates between retrieval-augmented generation and generation-augmented retrieval: the model first generates an answer conditioned on retrieved passages, then uses that generated text to issue a refined retrieval query, and repeats this synergy loop so that generation and retrieval progressively reinforce each other. This iterative refinement improves answer quality on multi-hop question answering over a single retrieve-then-read pass, illustrating that letting generation steer subsequent retrieval is valuable even without a learned policy.

**Adaptive-RAG** (Jeong et al., 2024) [@jeong2024adaptive] classifies incoming queries into complexity levels and routes them to different retrieval strategies: simple questions go through single-step retrieval, moderate questions use multi-step retrieval, and complex questions trigger iterative search with reasoning. This routing approach matches retrieval effort to question difficulty, improving both efficiency and quality.

### Comparing the Approaches

The methods above differ mainly in three design choices: what signal triggers retrieval, how many retrieval hops they perform, and how each new query is formulated. The table below summarizes these axes.

| Method | Triggering signal | Number of hops | Query-formulation strategy |
| --- | --- | --- | --- |
| In-context RAG | None (retrieve once, up front) | One | Original question |
| IRCoT | Each chain-of-thought step | Variable (until reasoning terminates) | Query derived from the latest reasoning step |
| FLARE | Generation confidence falls below a threshold | Variable (only when uncertain) | Low-confidence generated span used as the query |
| DSP / DSPy | Program structure (fixed pipeline) | Fixed by the program | Intermediate demonstrations used as queries |
| ITER-RETGEN | Fixed schedule | Fixed number of iterations | Previous-round answer used to refine the query |
| ITRG (Feng et al.) | Fixed schedule | Fixed number of iterations | Generated text used to refine the retrieval query |
| Adaptive-RAG | Predicted query complexity | Routed (one, multi, or iterative) | Strategy chosen per question |

Read together, these methods trace a progression in the "when to retrieve" decision. In-context RAG retrieves once and is the baseline every other method must beat. ITER-RETGEN and ITRG retrieve on a fixed schedule, trading extra calls for refined queries. IRCoT ties retrieval to reasoning structure rather than a fixed count, so the number of hops adapts to the question. FLARE pushes this further by making the model's own uncertainty the trigger, retrieving only when parametric knowledge runs short. Adaptive-RAG sits at the top of this progression, choosing the entire strategy per question. The trend is a steady move from fixed, question-agnostic retrieval toward signal-driven, per-question control of retrieval effort.

### The Multi-Hop Reasoning Gap

Despite significant progress, there remains a substantial gap between current multi-hop retrieval systems and human-level multi-hop reasoning. Press et al. (2023) [@press2023measuring] formally measured this "compositionality gap" (the fraction of multi-hop questions that a model answers incorrectly despite answering all constituent sub-questions correctly) and found it to be approximately 40% on the GPT-3 family, with the gap staying roughly constant across model sizes from 1B to 175B parameters rather than shrinking with scale. StrategyQA (Geva et al., 2021) [@geva2023strategyqa] demonstrated that questions requiring implicit multi-step reasoning strategies (where the decomposition is not obvious from the question text) are particularly challenging. Current systems struggle with: (1) questions requiring more than 3-4 hops, where error accumulates across reasoning steps; (2) questions requiring numerical reasoning or comparison across retrieved evidence; (3) questions where the relevant evidence is spread across many documents with varying quality; and (4) questions requiring common-sense reasoning to bridge gaps between retrieved facts. Closing this gap likely requires advances in both retrieval (finding the right evidence) and reasoning (combining evidence correctly).
