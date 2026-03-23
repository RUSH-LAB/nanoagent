---
sidebar_position: 8
title: "Monte Carlo Tree Search + LLMs"
---

## Monte Carlo Tree Search + LLMs

Tree search methods enable systematic exploration of solution spaces, combining the strengths of LLMs (generating candidates) with search (evaluating and selecting among them).

### Tree-of-Thought (ToT)

Yao et al. (2023) [@yao2023tree] proposed Tree-of-Thought, which generalizes chain-of-thought prompting to a tree structure where the LLM explores multiple reasoning paths. At each step, the model generates several candidate "thoughts," evaluates their promise using the LLM itself, and uses breadth-first or depth-first search to explore the most promising branches. ToT demonstrated significant improvements on tasks requiring planning and systematic exploration (e.g., Game of 24, creative writing, crossword puzzles).

### Reasoning via Planning (RAP)

Hao et al. (2023) [@hao2023reasoning] proposed RAP, which frames LLM reasoning as planning with a world model. The LLM serves as both the world model (predicting the results of reasoning steps) and the reasoning agent. MCTS is used to explore the reasoning tree, with the LLM providing value estimates for tree node evaluation. RAP demonstrated that treating reasoning as search significantly improves performance on mathematical and logical reasoning tasks.

### Language Agent Tree Search (LATS)

Zhou et al. (2024) [@zhou2024lats] proposed LATS, which unifies reasoning, acting, and planning in language agents using Monte Carlo Tree Search. LATS uses the LLM as a heuristic within MCTS to: generate candidate actions (expansion), evaluate states (simulation), and propagate values (backpropagation). External feedback (tool outputs, environment observations) provides grounding. LATS achieved state-of-the-art performance on HumanEval code generation and WebShop shopping tasks.

### AlphaProof and Mathematical Search

Google DeepMind's AlphaProof (2024) [@deepmind2024alphaproof] combined a language model (Gemini) with reinforcement learning and tree search to solve International Mathematical Olympiad problems. AlphaProof generates proof candidates in Lean 4 formal language, uses a value function to evaluate partial proofs, and searches through the proof space using MCTS. At IMO 2024, AlphaProof (combined with AlphaGeometry 2) achieved a silver medal-level score, demonstrating the power of search-guided mathematical reasoning.

### Best-of-N Sampling and Reward-Guided Search

A simpler but surprisingly effective form of search is **best-of-N sampling** (also called rejection sampling): generate N candidate solutions, score them with a reward model or verifier, and return the best one. This approach requires no tree search infrastructure -- just parallel generation and scoring. Self-consistency (Wang et al., 2023) [@wang2023selfconsistency] demonstrated a related principle: sampling multiple reasoning chains and selecting the answer by majority vote substantially improves accuracy, even without a trained verifier. When combined with process reward models (PRMs) that evaluate intermediate reasoning steps [@lightman2023prm], best-of-N sampling achieves substantial improvements over single-sample generation. For example, on the MATH dataset, generating 256 solutions and selecting the best via PRM scoring improves accuracy from ~50% to ~78%.

The key insight is that many LLM failures are not capability limitations but **sampling failures** -- the model is capable of producing the correct answer but does not always do so on a single attempt. Recent work has shown that chain-of-thought reasoning can emerge without explicit prompting through careful decoding strategies [@chen2024cot_decoding]. Search (whether tree search or best-of-N) addresses sampling failures by exploring more of the solution space, and the role of the reward model is to identify the correct solutions among the candidates. This perspective connects LLM reasoning to the classical explore-exploit tradeoff in reinforcement learning.

### Test-Time Compute Scaling

A unifying perspective on search-augmented LLMs is **test-time compute scaling**: using more computation at inference time (through search, multi-step reasoning, or iterative refinement) to achieve better results. While pre-training compute follows well-characterized scaling laws, the relationship between test-time compute and output quality is a newer research direction. Early results suggest that test-time compute can be as effective as pre-training compute for reasoning tasks -- a finding with profound implications for model deployment (it may be more cost-effective to run a smaller model with more search than to train a larger model) [@snell2024scaling_testtime].

### Reflexion: Verbal Reinforcement Learning

Shinn et al. (2023) [@shinn2023reflexion] proposed Reflexion, which enables language agents to learn from their mistakes through **verbal self-reflection**. After a failed attempt at a task, the agent generates a verbal reflection describing what went wrong and how to improve, then uses this reflection to guide its next attempt. Unlike traditional RL (which updates model weights), Reflexion stores reflections in an episodic memory buffer that conditions future attempts. Reflexion achieved significant improvements on HumanEval code generation (from 80% to 91% pass@1), ALFWorld decision-making, and HotpotQA question answering, demonstrating that self-reflection is a powerful form of search through strategy space.

### Self-Refine: Iterative Self-Improvement

Madaan et al. (2023) [@madaan2023selfrefine] proposed Self-Refine, which uses the same LLM to iteratively generate, critique, and refine its own outputs. The process is: (1) generate an initial output, (2) provide feedback by critiquing the output, (3) refine the output based on the feedback, (4) repeat until the output meets quality criteria. Self-Refine demonstrated that this iterative self-improvement loop consistently improves output quality across diverse tasks (code optimization, math reasoning, sentiment transfer, dialogue) without any additional training. The key insight is that LLMs are often better at evaluating and critiquing outputs than at generating perfect outputs on the first attempt -- so iterative refinement through self-evaluation is a form of search that exploits this asymmetry.
