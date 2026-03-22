---
sidebar_position: 6
title: "Multi-Hop Reasoning Search"
---

## Multi-Hop Reasoning Search

Many complex questions require combining information from multiple sources through multi-step reasoning.

### IRCoT

Trivedi et al. (2023) [@trivedi2023ircot] proposed IRCoT (Interleaving Retrieval with Chain-of-Thought reasoning), which alternates between chain-of-thought reasoning steps and retrieval queries. After each reasoning step, the model generates a targeted search query based on what it needs to know next, retrieves relevant passages, and incorporates them into the next reasoning step. IRCoT demonstrated significant improvements over one-shot retrieval on multi-hop question-answering benchmarks like HotpotQA and 2WikiMultiHopQA.

### FLARE

Jiang et al. (2023) [@jiang2023flare] proposed FLARE (Forward-Looking Active REtrieval), which triggers retrieval only when the model's confidence drops during generation. FLARE monitors the probability of generated tokens, and when confidence falls below a threshold, it uses the generated low-confidence tokens as a query to retrieve supporting evidence. This "active" retrieval strategy avoids unnecessary searches while ensuring retrieval happens when the model is uncertain.

### Adaptive Retrieval Strategies

More recent work has explored learned policies for deciding when, what, and how to retrieve. These systems use reinforcement learning or learned classifiers to optimize the retrieval strategy based on the specific question and available evidence [@shao2023enhancing, @feng2024retrieval]. The goal is to move from rule-based retrieval triggers to learned, context-dependent retrieval policies.
