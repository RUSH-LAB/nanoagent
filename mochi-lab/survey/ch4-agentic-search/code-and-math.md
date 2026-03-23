---
sidebar_position: 10
title: "Search in Code & Math"
---

## Search in Code & Math

Code generation and mathematical reasoning represent some of the most compelling applications of agentic search, because they have **verifiable outcomes**: a generated program either passes its tests or it does not, and a mathematical proof either verifies or it does not. This verifiability enables clean evaluation and provides strong training signals for self-improvement.

### AlphaCode and Competitive Programming

Li et al. (2022) [@li2022alphacode] introduced AlphaCode (DeepMind), which uses large-scale code generation combined with filtering and clustering to solve competitive programming problems. The search strategy is "massive generation followed by intelligent selection": AlphaCode generates up to 1 million candidate solutions per problem, filters them using the provided test cases, clusters the remaining correct solutions (using a learned similarity model), and submits representatives from each cluster. This "generate-and-filter" approach achieved competitive programming performance at the level of a median participant on Codeforces (top 54.3%), demonstrating that search over a massive solution space, guided by test-based verification, can compensate for imperfect individual solution quality.

AlphaCode 2 (2023) [@alphacode2_2023] improved dramatically by using Gemini as the base model and incorporating better search strategies, achieving performance at the 85th percentile of Codeforces participants.

### SWE-bench and Software Engineering Agents

Jimenez et al. (2024) [@jimenez2024swebench] introduced SWE-bench, a benchmark of real-world GitHub issues from popular Python repositories (Django, Flask, scikit-learn, etc.), where agents must find and fix actual bugs by navigating codebases, understanding code, and producing correct patches. SWE-bench has become the standard evaluation for software engineering agents.

**SWE-Agent** (Yang et al., 2024) [@yang2024sweagent] designed a custom agent-computer interface optimized for LLM-based software engineering. SWE-Agent provides the LLM with specialized commands for navigating codebases (search, open files, scroll), editing code (edit specific lines), and running tests, achieving significantly better performance than agents using raw bash commands. SWE-Agent resolved 12.5% of SWE-bench issues (later improved with better models).

**OpenHands** (Wang et al., 2024) [@wang2024openhands] (formerly OpenDevin) provides a framework for building software development agents that can browse the web, write code, and execute commands. OpenHands supports multiple agent architectures (CodeAct, browsing agents) and has achieved state-of-the-art performance on SWE-bench.

The rapid progress on SWE-bench -- from ~3% resolution rate to ~50%+ with frontier models and sophisticated agent architectures -- demonstrates that agentic search over codebases is becoming practically useful for automated software engineering.

### Proof Search in Formal Mathematics

Searching for mathematical proofs in formal languages (Lean, Isabelle, Coq) has become an active area combining LLMs with structured search. The proof search problem is: given a theorem statement, find a sequence of proof steps (tactics) that proves it, where each step transforms the proof state toward a verified conclusion.

**ReProver** (Yang et al., 2023) [@yang2023leandojo] proposed a retrieval-augmented approach to theorem proving in Lean, using a retriever to find relevant lemmas from the mathematical library and a generator to produce proof tactics. The combination of retrieval (finding useful building blocks) with generation (constructing proof steps) significantly outperforms generation alone.

**DeepSeek-Prover** (Xin et al., 2024) [@xin2024deepseekprover] uses a large language model with Monte Carlo Tree Search to explore the proof space systematically. DeepSeek-Prover-V1.5 combined MCTS with a process reward model that evaluates intermediate proof states, achieving near-state-of-the-art performance on formal mathematics benchmarks.

**AlphaProof** (Google DeepMind, 2024) [@deepmind2024alphaproof] combined Gemini with reinforcement learning and tree search to solve International Mathematical Olympiad problems in Lean 4. At IMO 2024, AlphaProof (combined with AlphaGeometry 2) achieved a silver medal-level score, solving 4 of 6 problems. This result demonstrated that the combination of LLM-based generation with formal verification and systematic search can achieve mathematical reasoning at an elite level.

### Process Reward Models for Math Reasoning

A key enabler for search in mathematical reasoning is the **process reward model (PRM)**, which evaluates intermediate reasoning steps rather than only final answers. Lightman et al. (2023) [@lightman2023prm] demonstrated that PRMs trained on step-by-step annotations outperform outcome reward models (ORMs) for guiding search in mathematical reasoning. When combined with best-of-N sampling or tree search, PRMs enable the model to identify and backtrack from incorrect reasoning steps, substantially improving accuracy on competition math benchmarks (MATH dataset accuracy improved from 50% to 78% with PRM-guided search).
