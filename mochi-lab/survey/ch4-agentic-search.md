# Chapter 4: Agentic Search

## 4.1 Introduction & Motivation

Traditional information retrieval operates on a simple paradigm: a user formulates a query, a system returns ranked results, and the user evaluates them. This static, one-shot interaction is fundamentally limited for complex information needs that require multi-step reasoning, synthesis across sources, or iterative refinement of understanding [1, 2].

Agentic search represents a paradigm shift: instead of returning documents, the system actively pursues answers through multi-step information-seeking strategies. An agentic search system can reformulate queries, follow citation chains, synthesize information from multiple sources, verify claims against evidence, and iteratively refine its understanding -- all autonomously [3, 4].

The emergence of large language models (LLMs) as capable reasoning engines has made agentic search practically viable. LLMs provide the "brain" that can plan search strategies, interpret results, decide what to search next, and synthesize findings into coherent answers. When augmented with tools -- web search engines, databases, APIs, code executors -- LLMs become search agents that can tackle information needs far beyond the reach of traditional IR systems [5, 6].

This chapter surveys the landscape of agentic search, from foundational retrieval-augmented generation (RAG) to sophisticated multi-hop reasoning systems, from web browsing agents to search-guided mathematical proof. We organize the literature by the level of agency: from passive retrieval augmentation, through active multi-step search, to fully autonomous search agents.

## 4.2 Problem Formulation

### Search as Sequential Decision-Making

Agentic search can be formalized as a sequential decision-making problem [7]. At each step t, the agent observes a state s_t (comprising the current query, retrieved information, and reasoning context), selects an action a_t (search query, tool call, or reasoning step), and receives an observation o_{t+1}. The process continues until a termination condition is met (answer found, confidence threshold reached, or budget exhausted).

The objective is to maximize the quality of the final answer while minimizing search cost:

maximize Quality(answer) - lambda * Cost(search_trajectory)

where Cost may include the number of search queries, API calls, tokens processed, or wall-clock time.

### Reward Signals

Defining reward signals for agentic search is challenging. Unlike game-playing settings where rewards are well-defined, search quality is often subjective and can only be evaluated after the full search trajectory is complete. Common proxy rewards include: answer accuracy on benchmark questions, faithfulness to retrieved evidence, citation quality, and user satisfaction ratings [8, 9].

### Key Challenges

Agentic search must address several fundamental challenges:
- **When to search:** Not all questions require retrieval; the agent must decide when its parametric knowledge is sufficient vs. when external evidence is needed.
- **What to search for:** Query formulation is critical -- the same information need can be expressed as many different queries with vastly different retrieval results.
- **When to stop:** The agent must balance thoroughness against cost, deciding when enough evidence has been gathered.
- **How to synthesize:** Combining information from multiple, potentially contradictory sources into a coherent, faithful answer.

## 4.3 Taxonomy of Approaches

Agentic search methods can be organized by their level of agency and architectural paradigm:

1. **Tool-Augmented Retrieval:** LLMs that can invoke search tools as part of generation.
2. **Retrieval-Augmented Generation (RAG):** Systems that retrieve and condition on external documents.
3. **Multi-Hop Reasoning Search:** Systems that perform iterative retrieval interleaved with reasoning.
4. **Agentic Web Search:** Autonomous agents that browse the web and interact with web interfaces.
5. **Search with Planning (MCTS + LLMs):** Systems that use tree search for systematic exploration.
6. **Self-Improving Search:** Systems that adaptively refine their search strategies.

## 4.4 Tool-Augmented Retrieval

### 4.4.1 WebGPT

Nakano et al. (2022) [10] developed WebGPT, one of the first systems to train an LLM to use a web search engine as a tool. WebGPT was fine-tuned via human feedback to issue search queries, click on results, quote passages, and compose answers with citations. Trained with both behavior cloning and reinforcement learning from human feedback, WebGPT demonstrated that LLMs could learn effective search strategies, often outperforming humans on the ELI5 long-form question-answering benchmark.

### 4.4.2 Toolformer

Schick et al. (2023) [11] introduced Toolformer, which teaches LLMs to use external tools (including search engines, calculators, and translation APIs) in a self-supervised manner. Rather than requiring human demonstrations, Toolformer uses the LLM itself to generate and filter tool-use annotations, then fine-tunes on the successful ones. This bootstrapping approach scales more easily than human-supervised methods.

### 4.4.3 ReAct

Yao et al. (2023) [12] proposed ReAct (Reasoning + Acting), a prompting framework where the LLM alternates between reasoning traces (thinking about what to do) and actions (search queries, lookups). By interleaving reasoning with action, ReAct enables more systematic and interpretable search strategies than pure action-based approaches. ReAct has become a foundational pattern for LLM-based agents.

### 4.4.4 TALM

Parisi et al. (2022) [13] proposed TALM (Tool Augmented Language Models), which iteratively fine-tunes language models on tool-use examples generated by the model itself. TALM demonstrated that tool-use capability improves with scale and that self-generated training data can bootstrap effective tool-use learning.

## 4.5 Retrieval-Augmented Generation (RAG)

RAG systems retrieve relevant documents and condition the LLM's generation on this retrieved context, grounding responses in external evidence.

### 4.5.1 REALM

Guu et al. (2020) [14] proposed REALM (Retrieval-Augmented Language Model), which jointly pre-trains a retriever and a language model. The retriever is treated as a latent variable, and the entire system is trained end-to-end using the language modeling objective. REALM demonstrated that incorporating retrieval into pre-training produces models with better factual knowledge and improved downstream task performance.

### 4.5.2 RAG (Lewis et al.)

Lewis et al. (2020) [15] introduced the RAG framework, combining a pre-trained retriever (DPR) with a pre-trained seq2seq generator (BART). RAG retrieves relevant passages for each input and conditions generation on them, with two variants: RAG-Token (retrieves separately for each output token) and RAG-Sequence (retrieves once for the entire output). RAG established the foundational architecture that most subsequent retrieval-augmented systems build upon.

### 4.5.3 RETRO

Borgeaud et al. (2022) [16] proposed RETRO (Retrieval-Enhanced Transformer), which scales retrieval augmentation to trillions of tokens. RETRO retrieves chunks from a massive database at each layer of the transformer using cross-attention, achieving performance comparable to a 25x larger model without retrieval. RETRO demonstrated that retrieval can substitute for parametric scale, offering a more efficient path to knowledge-intensive performance.

### 4.5.4 Atlas

Izacard et al. (2023) [17] introduced Atlas, which jointly trains a retriever and language model with few-shot learning capabilities. Atlas matches the performance of 540B-parameter PaLM on knowledge-intensive tasks using only 11B parameters, demonstrating the power of retrieval augmentation for parameter efficiency.

### 4.5.5 Self-RAG

Asai et al. (2024) [18] proposed Self-RAG, which trains an LLM to adaptively retrieve, generate, and self-reflect. Unlike standard RAG, which always retrieves, Self-RAG learns special "reflection tokens" that determine when to retrieve, evaluate whether retrieved passages are relevant, and assess whether the generated response is supported by the evidence. This self-reflective approach reduces unnecessary retrieval and improves factual accuracy.

## 4.6 Multi-Hop Reasoning Search

Many complex questions require combining information from multiple sources through multi-step reasoning.

### 4.6.1 IRCoT

Trivedi et al. (2023) [19] proposed IRCoT (Interleaving Retrieval with Chain-of-Thought reasoning), which alternates between chain-of-thought reasoning steps and retrieval queries. After each reasoning step, the model generates a targeted search query based on what it needs to know next, retrieves relevant passages, and incorporates them into the next reasoning step. IRCoT demonstrated significant improvements over one-shot retrieval on multi-hop question-answering benchmarks like HotpotQA and 2WikiMultiHopQA.

### 4.6.2 FLARE

Jiang et al. (2023) [20] proposed FLARE (Forward-Looking Active REtrieval), which triggers retrieval only when the model's confidence drops during generation. FLARE monitors the probability of generated tokens, and when confidence falls below a threshold, it uses the generated low-confidence tokens as a query to retrieve supporting evidence. This "active" retrieval strategy avoids unnecessary searches while ensuring retrieval happens when the model is uncertain.

### 4.6.3 Adaptive Retrieval Strategies

More recent work has explored learned policies for deciding when, what, and how to retrieve. These systems use reinforcement learning or learned classifiers to optimize the retrieval strategy based on the specific question and available evidence [21, 22]. The goal is to move from rule-based retrieval triggers to learned, context-dependent retrieval policies.

## 4.7 Agentic Web Search

### 4.7.1 WebArena

Zhou et al. (2024) [23] introduced WebArena, a realistic web-based benchmark for evaluating autonomous web agents. WebArena provides self-hosted websites (shopping, forums, maps, GitLab) with hundreds of tasks requiring complex web interactions. State-of-the-art LLM agents (GPT-4) achieve only ~15% success rate, highlighting the substantial gap between current capabilities and human-level web browsing proficiency.

### 4.7.2 BrowserGym

Drouin et al. (2024) [24] proposed BrowserGym, a unified ecosystem for web agent research that standardizes the observation and action spaces across multiple web benchmarks. BrowserGym provides a gym-like interface for training and evaluating web agents, enabling systematic comparison of different agent architectures and training methods.

### 4.7.3 Mind2Web

Deng et al. (2024) [25] introduced Mind2Web, a benchmark and dataset for training generalist web agents. Mind2Web covers 2,000+ tasks across 137 real-world websites, providing HTML snapshots and human action traces. Unlike simulated environments, Mind2Web uses real websites, capturing the complexity and diversity of the actual web.

### 4.7.4 Agent Architectures for Web Browsing

Web browsing agents typically combine an LLM "brain" with a browser tool that can navigate pages, click elements, fill forms, and extract content. Key architectural choices include: observation representation (raw HTML, accessibility tree, screenshots), action space design (low-level clicks vs. high-level instructions), and planning strategies (reactive vs. deliberative) [26, 27].

## 4.8 Monte Carlo Tree Search + LLMs

Tree search methods enable systematic exploration of solution spaces, combining the strengths of LLMs (generating candidates) with search (evaluating and selecting among them).

### 4.8.1 Tree-of-Thought (ToT)

Yao et al. (2023) [28] proposed Tree-of-Thought, which generalizes chain-of-thought prompting to a tree structure where the LLM explores multiple reasoning paths. At each step, the model generates several candidate "thoughts," evaluates their promise using the LLM itself, and uses breadth-first or depth-first search to explore the most promising branches. ToT demonstrated significant improvements on tasks requiring planning and systematic exploration (e.g., Game of 24, creative writing, crossword puzzles).

### 4.8.2 Reasoning via Planning (RAP)

Hao et al. (2023) [29] proposed RAP, which frames LLM reasoning as planning with a world model. The LLM serves as both the world model (predicting the results of reasoning steps) and the reasoning agent. MCTS is used to explore the reasoning tree, with the LLM providing value estimates for tree node evaluation. RAP demonstrated that treating reasoning as search significantly improves performance on mathematical and logical reasoning tasks.

### 4.8.3 Language Agent Tree Search (LATS)

Zhou et al. (2024) [30] proposed LATS, which unifies reasoning, acting, and planning in language agents using Monte Carlo Tree Search. LATS uses the LLM as a heuristic within MCTS to: generate candidate actions (expansion), evaluate states (simulation), and propagate values (backpropagation). External feedback (tool outputs, environment observations) provides grounding. LATS achieved state-of-the-art performance on HumanEval code generation and WebShop shopping tasks.

### 4.8.4 AlphaProof and Mathematical Search

Google DeepMind's AlphaProof (2024) [31] combined a language model (Gemini) with reinforcement learning and tree search to solve International Mathematical Olympiad problems. AlphaProof generates proof candidates in Lean 4 formal language, uses a value function to evaluate partial proofs, and searches through the proof space using MCTS. At IMO 2024, AlphaProof (combined with AlphaGeometry 2) achieved a silver medal-level score, demonstrating the power of search-guided mathematical reasoning.

## 4.9 Self-Improving Search

### 4.9.1 STORM

Shao et al. (2024) [32] introduced STORM (Synthesis of Topic Outlines through Retrieval and Multi-perspective question asking), a system that writes Wikipedia-style articles through multi-turn search and synthesis. STORM first researches a topic by simulating conversations with topic experts (generated by the LLM), using each expert's questions to drive targeted searches. It then synthesizes the gathered information into a structured article with proper citations. STORM demonstrated that iterative, perspective-driven search produces more comprehensive and well-organized content than single-pass retrieval.

### 4.9.2 Iterative Retrieval and Refinement

Several systems implement iterative search loops where the model alternates between retrieval, reading, and query refinement [33, 34]. Each iteration refines the model's understanding, enabling it to ask more targeted questions. Key techniques include:
- **Query reformulation:** Rewriting queries based on initial results to find more relevant information.
- **Gap detection:** Identifying what information is still missing and generating targeted queries.
- **Evidence verification:** Cross-checking claims against multiple sources before including them.

### 4.9.3 Adaptive Query Reformulation

Modern search systems learn to reformulate queries based on the quality of initial results. If the first search returns irrelevant documents, the agent rewrites the query using different terminology, decomposes the question into sub-questions, or searches for related concepts that might provide indirect evidence [35].

## 4.10 Search in Code & Math

### 4.10.1 AlphaCode

Li et al. (2022) [36] introduced AlphaCode (DeepMind), which uses large-scale code generation combined with filtering and clustering to solve competitive programming problems. AlphaCode generates millions of candidate solutions, filters them using test cases, clusters the remaining solutions, and submits representatives from each cluster. This "generate-and-filter" approach to code search achieved competitive programming performance at the level of a median participant on Codeforces.

### 4.10.2 CodeSearchNet and Code Retrieval

Husain et al. (2019) [37] introduced CodeSearchNet, a benchmark for semantic code search -- retrieving relevant code snippets given natural language queries. Modern code search leverages embedding models that map code and natural language into a shared vector space, enabling semantic matching that goes beyond keyword-based search.

### 4.10.3 Proof Search in Formal Mathematics

Searching for mathematical proofs in formal languages (Lean, Isabelle, Coq) has become an active area combining LLMs with structured search. Systems like LEGO-Prover [38], ReProver [39], and DeepSeek-Prover [40] use LLMs to generate proof steps (tactics) and search algorithms (BFS, MCTS) to explore the proof tree. This represents one of the purest forms of agentic search: the agent must navigate a vast space of possible proof steps to reach a verified conclusion.

## 4.11 Benchmarks & Evaluation

### Retrieval Benchmarks

- **KILT** (Petroni et al., 2021) [41]: Knowledge Intensive Language Tasks, a unified benchmark covering fact-checking, question answering, slot filling, entity linking, and dialogue, all requiring retrieval from Wikipedia.
- **BEIR** (Thakur et al., 2021) [42]: Benchmarking IR, a heterogeneous benchmark of 18 retrieval datasets spanning diverse domains and task types, evaluating zero-shot retrieval performance.

### Question Answering Benchmarks

- **HotpotQA** (Yang et al., 2018) [43]: Multi-hop question answering requiring reasoning over two or more Wikipedia paragraphs.
- **FEVER** (Thorne et al., 2018) [44]: Fact Extraction and VERification, requiring systems to verify claims against Wikipedia evidence.
- **Natural Questions** (Kwiatkowski et al., 2019) [45]: Real Google search queries with answers from Wikipedia.

### Agent Benchmarks

- **WebArena** [23]: Realistic web interaction tasks on self-hosted websites.
- **Mind2Web** [25]: Real-world web task completion across 137 websites.
- **GAIA** (Mialon et al., 2024) [46]: General AI Assistants benchmark requiring multi-step tool use and reasoning.
- **SWE-bench** (Jimenez et al., 2024) [47]: Software engineering tasks requiring agents to find and fix real GitHub issues.

## 4.12 Open Problems & Future Directions

### Hallucination Mitigation

Even with retrieval augmentation, LLMs can generate content not supported by retrieved evidence -- "retrieval-augmented hallucination" [48]. Key challenges include: faithful attribution (every claim backed by a cited source), handling conflicting evidence, and knowing when retrieved information is insufficient to answer the question.

### Search Cost Control

Agentic search can be expensive, involving many LLM calls and retrieval operations. Developing cost-aware search policies that optimize the quality-cost tradeoff is critical for practical deployment. This connects to the optimal stopping problem in statistics [49].

### Attribution and Provenance

Users increasingly demand to know where information comes from. Building search systems that produce verifiable attribution -- traceable chains from claims to source documents -- remains technically challenging, especially when answers synthesize information from multiple sources [50].

### Multi-Modal Search

Searching across modalities (text, images, video, code, structured data) with a unified agent that can reason about multi-modal evidence is an emerging frontier. Current systems typically handle each modality separately.

### Personalized Search

Adapting search strategies to individual user preferences, expertise levels, and information needs -- without explicit preference elicitation -- is a largely unsolved problem in the agentic search context.

## 4.13 Connections to Other Chapters

**World Models (Chapter 2):** World models enable agents to "search" through possible futures by simulating action outcomes. MuZero-style planning with learned world models is fundamentally a search problem. Agentic search can also be viewed as building a world model of the information landscape -- understanding what information exists, where it is, and how to access it.

**Efficient Architectures (Chapter 3):** The cost of agentic search is dominated by LLM inference calls. Efficient inference techniques (speculative decoding, KV-cache optimization, quantization) directly impact the feasibility of multi-step search. Additionally, efficient retrieval models (cross-encoders, bi-encoders, late interaction models) are critical for the retrieval component.

**Continual Learning (Chapter 1):** Search agents that operate over time must continually update their knowledge of available information sources, search strategies, and domain expertise. Retrieval indices must be updated as new documents are added, creating a continual learning challenge for the retrieval component.

**Randomized Algorithms (Chapter 5):** Approximate nearest neighbor search (the backbone of dense retrieval) relies on randomized data structures: locality-sensitive hashing, random projections, and randomized tree-based indices. The efficiency of vector search directly impacts the viability of retrieval-heavy agentic systems.

## References

- [1] Metzler, D., Tay, Y., Bahri, D., and Najork, M. "Rethinking Search: Making Domain Experts out of Dilettantes." SIGIR Forum, 2021.
- [2] Nakano, R., et al. "WebGPT: Browser-assisted Question-Answering with Human Feedback." arXiv:2112.09332, 2021.
- [3] Singh, A., et al. "Agentic Retrieval-Augmented Generation: A Survey on Agentic RAG." arXiv:2501.09136, 2025. https://arxiv.org/abs/2501.09136
- [4] Wang, L., Ma, C., Feng, X., et al. "A Survey on Large Language Model Based Autonomous Agents." Frontiers of Computer Science, 2024.
- [5] Qin, Y., Hu, S., Lin, Y., et al. "Tool Learning with Foundation Models." arXiv:2304.08354, 2023.
- [6] Schick, T., Dwivedi-Yu, J., Dessi, R., et al. "Toolformer: Language Models Can Teach Themselves to Use Tools." NeurIPS, 2023.
- [7] Sutton, R.S. and Barto, A.G. "Reinforcement Learning: An Introduction." MIT Press, 2018.
- [8] Gao, T., Yen, H., Yu, J., and Chen, D. "Enabling Large Language Models to Generate Text with Citations." EMNLP, 2023.
- [9] Liu, N., Zhang, T., and Liang, P. "Evaluating Verifiability in Generative Search Engines." EMNLP Findings, 2023.
- [10] Nakano, R., et al. "WebGPT: Browser-assisted Question-Answering with Human Feedback." arXiv:2112.09332, 2022.
- [11] Schick, T., et al. "Toolformer: Language Models Can Teach Themselves to Use Tools." NeurIPS, 2023.
- [12] Yao, S., Zhao, J., Yu, D., et al. "ReAct: Synergizing Reasoning and Acting in Language Models." ICLR, 2023.
- [13] Parisi, A., Zhao, Y., and Fishi, N. "TALM: Tool Augmented Language Models." arXiv:2205.12255, 2022.
- [14] Guu, K., Lee, K., Tung, Z., Pasupat, P., and Chang, M.W. "Retrieval Augmented Language Model Pre-Training." ICML, 2020.
- [15] Lewis, P., Perez, E., Piktus, A., et al. "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks." NeurIPS, 2020.
- [16] Borgeaud, S., Mensch, A., Hoffmann, J., et al. "Improving Language Models by Retrieving from Trillions of Tokens." ICML, 2022.
- [17] Izacard, G., Lewis, P., Lomeli, M., et al. "Atlas: Few-shot Learning with Retrieval Augmented Language Models." JMLR, 2023.
- [18] Asai, A., Wu, Z., Wang, Y., Sil, A., and Hajishirzi, H. "Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection." ICLR, 2024.
- [19] Trivedi, H., Balasubramanian, N., Khot, T., and Sabharwal, A. "Interleaving Retrieval with Chain-of-Thought Reasoning for Knowledge-Intensive Multi-Step Questions." ACL, 2023. https://aclanthology.org/2023.acl-long.557/
- [20] Jiang, Z., Xu, F.F., Gao, L., et al. "Active Retrieval Augmented Generation." EMNLP, 2023.
- [21] Shao, Z., Gong, Y., Shen, Y., et al. "Enhancing Retrieval-Augmented Large Language Models with Iterative Retrieval-Generation Synergy." EMNLP Findings, 2023.
- [22] Feng, Z., Feng, X., Zhao, D., Yang, M., and Qin, B. "Retrieval-Generation Synergy Augmented Large Language Models." EMNLP Findings, 2024.
- [23] Zhou, S., Xu, F.F., Zhu, H., et al. "WebArena: A Realistic Web Environment for Building Autonomous Agents." ICLR, 2024.
- [24] Drouin, A., et al. "The BrowserGym Ecosystem for Web Agent Research." arXiv:2412.05467, 2024. https://arxiv.org/abs/2412.05467
- [25] Deng, X., Gu, Y., Zheng, B., et al. "Mind2Web: Towards a Generalist Agent for the Web." NeurIPS, 2024.
- [26] Zheng, L., Chiang, W.L., Sheng, Y., et al. "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena." NeurIPS, 2023.
- [27] He, H., et al. "WebVoyager: Building an End-to-End Web Agent with Large Multimodal Models." ACL, 2024.
- [28] Yao, S., Yu, D., Zhao, J., et al. "Tree of Thoughts: Deliberate Problem Solving with Large Language Models." NeurIPS, 2023.
- [29] Hao, S., Gu, Y., Ma, H., et al. "Reasoning with Language Model is Planning with World Model." EMNLP, 2023.
- [30] Zhou, A., Yan, Y., Shao, M., et al. "Language Agent Tree Search Unifies Reasoning Acting and Planning in Language Models." ICML, 2024. https://arxiv.org/abs/2310.04406
- [31] Google DeepMind. "AI Achieves Silver-Medal Standard Solving International Mathematical Olympiad Problems." 2024. https://deepmind.google/blog/ai-solves-imo-problems-at-silver-medal-level/
- [32] Shao, Y., Jiang, Y., Kanell, T.A., et al. "Assisting in Writing Wikipedia-like Articles From Scratch with Large Language Models." NAACL, 2024.
- [33] Xu, S., Pang, L., Shen, H., Cheng, X., and Chua, T.S. "Search-in-the-Chain: Interactively Enhancing Large Language Models with Search for Knowledge-intensive Tasks." WWW, 2024.
- [34] Kim, G., Kim, S., Jeon, B., Park, J., and Kang, J. "Tree of Clarifications: Answering Ambiguous Questions with Retrieval-Augmented Large Language Models." EMNLP, 2023.
- [35] Ma, X., et al. "Query Rewriting for Retrieval-Augmented Large Language Models." EMNLP, 2023.
- [36] Li, Y., Choi, D., Chung, J., et al. "Competition-Level Code Generation with AlphaCode." Science, 2022.
- [37] Husain, H., Wu, H.H., Gazit, T., Allamanis, M., and Brockschmidt, M. "CodeSearchNet Challenge: Evaluating the State of Semantic Code Search." arXiv:1909.09436, 2019.
- [38] Wang, H., et al. "LEGO-Prover: Neural Theorem Proving with Growing Libraries." ICLR, 2024.
- [39] Yang, K., et al. "LeanDojo: Theorem Proving with Retrieval-Augmented Language Models." NeurIPS, 2023.
- [40] Xin, H., et al. "DeepSeek-Prover: Advancing Theorem Proving in LLMs through Large-Scale Synthetic Data." arXiv:2405.14333, 2024.
- [41] Petroni, F., Piktus, A., Fan, A., et al. "KILT: A Benchmark for Knowledge Intensive Language Tasks." NAACL, 2021.
- [42] Thakur, N., Reimers, N., Ruckle, A., Srivastava, A., and Gurevych, I. "BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models." NeurIPS, 2021.
- [43] Yang, Z., Qi, P., Zhang, S., et al. "HotpotQA: A Dataset for Diverse, Explainable Multi-hop Question Answering." EMNLP, 2018.
- [44] Thorne, J., Vlachos, A., Christodoulopoulos, C., and Mittal, A. "FEVER: A Large-scale Dataset for Fact Extraction and VERification." NAACL, 2018.
- [45] Kwiatkowski, T., Palomaki, J., Redfield, O., et al. "Natural Questions: A Benchmark for Question Answering Research." TACL, 2019.
- [46] Mialon, G., et al. "GAIA: A Benchmark for General AI Assistants." ICLR, 2024.
- [47] Jimenez, C.E., Yang, J., Wettig, A., et al. "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?" ICLR, 2024.
- [48] Shi, W., Han, S.W., Lewis, M., et al. "Trusting Your Evidence: Hallucinate Less with Context-Aware Decoding." NAACL Findings, 2024.
- [49] Ferguson, T.S. "Optimal Stopping and Applications." Mathematics Department, UCLA, 2006.
- [50] Rashkin, H., Nikolaev, V., Lamm, M., et al. "Measuring Attribution in Natural Language Generation Models." CL, 2023.
