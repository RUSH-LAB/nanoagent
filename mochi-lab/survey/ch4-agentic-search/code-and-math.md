---
sidebar_position: 10
title: "Search in Code & Math"
---

## Search in Code & Math

### AlphaCode

Li et al. (2022) [@li2022alphacode] introduced AlphaCode (DeepMind), which uses large-scale code generation combined with filtering and clustering to solve competitive programming problems. AlphaCode generates millions of candidate solutions, filters them using test cases, clusters the remaining solutions, and submits representatives from each cluster. This "generate-and-filter" approach to code search achieved competitive programming performance at the level of a median participant on Codeforces.

### CodeSearchNet and Code Retrieval

Husain et al. (2019) [@husain2019codesearchnet] introduced CodeSearchNet, a benchmark for semantic code search -- retrieving relevant code snippets given natural language queries. Modern code search leverages embedding models that map code and natural language into a shared vector space, enabling semantic matching that goes beyond keyword-based search.

### Proof Search in Formal Mathematics

Searching for mathematical proofs in formal languages (Lean, Isabelle, Coq) has become an active area combining LLMs with structured search. Systems like LEGO-Prover [@wang2024legoprover], ReProver [@yang2023leandojo], and DeepSeek-Prover [@xin2024deepseekprover] use LLMs to generate proof steps (tactics) and search algorithms (BFS, MCTS) to explore the proof tree. This represents one of the purest forms of agentic search: the agent must navigate a vast space of possible proof steps to reach a verified conclusion.
