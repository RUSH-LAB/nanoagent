---
sidebar_position: 11
title: "Benchmarks & Evaluation"
---

## Benchmarks & Evaluation

Evaluating agentic search systems is challenging because they operate at the intersection of retrieval, reasoning, generation, and tool use. Different benchmarks test different capabilities, and no single benchmark captures the full range of agentic search behaviors.

### Retrieval Benchmarks

- **KILT (Knowledge Intensive Language Tasks)** (Petroni et al., 2021) [@petroni2021kilt]: A unified benchmark covering fact-checking, question answering, slot filling, entity linking, and dialogue, all requiring retrieval from Wikipedia. KILT's unified format enables fair comparison across diverse retrieval-augmented tasks.
- **BEIR (Benchmarking IR)** (Thakur et al., 2021) [@thakur2021beir]: A heterogeneous benchmark of 18 retrieval datasets spanning diverse domains (biomedical, financial, scientific) and task types (passage retrieval, question answering, fact verification). BEIR evaluates **zero-shot** retrieval performance, testing whether retrieval models generalize across domains without domain-specific training.
- **MTEB (Massive Text Embedding Benchmark)** (Muennighoff et al., 2023) [@muennighoff2023mteb]: The most comprehensive embedding evaluation, covering retrieval, classification, clustering, and semantic similarity across 56+ datasets. MTEB has become the standard leaderboard for text embedding models.

### Question Answering Benchmarks

- **HotpotQA** (Yang et al., 2018) [@yang2018hotpotqa]: Multi-hop question answering requiring reasoning over two or more Wikipedia paragraphs. HotpotQA provides both the question and the supporting facts, enabling evaluation of both answer quality and evidence selection.
- **FEVER (Fact Extraction and VERification)** (Thorne et al., 2018) [@thorne2018fever]: Requires systems to classify claims as Supported, Refuted, or Not Enough Info based on Wikipedia evidence, testing both retrieval and reasoning about evidence.
- **Natural Questions** (Kwiatkowski et al., 2019) [@kwiatkowski2019natural]: Real Google search queries with answers from Wikipedia, providing a realistic evaluation of open-domain question answering.
- **TriviaQA** (Joshi et al., 2017) [@joshi2017triviaqa]: Large-scale QA dataset with question-evidence pairs from trivia websites, testing retrieval over large document collections.
- **MuSiQue** (Trivedi et al., 2022) [@trivedi2022musique]: Multi-hop questions that are specifically designed to be unanswerable by single-hop retrieval, requiring genuine multi-step reasoning.
- **MMLU** (Hendrycks et al., 2021) [@hendrycks2021mmlu]: While primarily a knowledge benchmark, MMLU tests whether retrieval augmentation can improve performance on 57 academic subjects, revealing how much of LLM performance comes from parametric vs. retrievable knowledge.

### Agent Benchmarks

- **WebArena** [@zhou2024webarena]: Realistic web interaction tasks on self-hosted websites covering shopping, forums, code management, and maps. Tests complex multi-step web navigation and task completion.
- **VisualWebArena** [@koh2024visualwebarena]: Extension of WebArena requiring visual understanding of web pages (interpreting images, charts, visual layouts).
- **Mind2Web** [@deng2024mind2web]: Real-world web task completion across 137 diverse websites, with human action traces for training.
- **GAIA** (Mialon et al., 2024) [@mialon2024gaia]: General AI assistant benchmark requiring multi-step tool use and reasoning, designed to be easy for humans but hard for AI.
- **SWE-bench** (Jimenez et al., 2024) [@jimenez2024swebench]: Software engineering tasks requiring agents to find and fix real GitHub issues by navigating codebases, understanding code, and producing correct patches.
- **SWE-bench Verified** (OpenAI, 2024): A curated subset of SWE-bench where each task has been human-verified to be solvable and have correct test cases, providing more reliable evaluation than the original benchmark.
- **AgentBench** (Liu et al., 2024) [@liu2024agentbench]: A multi-dimensional benchmark evaluating LLM agents across 8 distinct environments including web shopping, database operations, and interactive coding.

### Evaluation Challenges

Evaluating agentic search systems presents unique challenges beyond those in standard NLP evaluation:

**Trajectory evaluation:** The quality of an agentic search system depends not just on its final answer but on the efficiency and correctness of its search trajectory. Two systems may arrive at the same answer, but one may do so with 3 search queries while the other uses 30 -- the former is clearly superior. Metrics that evaluate only the final answer miss this critical dimension.

**Reproducibility:** Agentic search results depend on the content of web pages and search engine results at the time of evaluation, which change constantly. This makes exact reproduction of results impossible and complicates longitudinal comparison of methods.

**Open-ended evaluation:** Many agentic search tasks (research questions, synthesis tasks) have no single correct answer, making automatic evaluation difficult. Human evaluation is expensive and subjective. LLM-as-judge approaches provide a scalable alternative but have their own biases [@zheng2023judging].

**Cost accounting:** Different systems may use different numbers of API calls, different model sizes, and different amounts of retrieved context. Fair comparison requires accounting for the total computational cost, not just the quality of the final output.
