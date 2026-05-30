---
sidebar_position: 13
title: "Connections to Other Chapters"
---

## Connections to Other Chapters

**World Models (Chapter 2):** World models and agentic search share the fundamental principle of model-based planning: using an internal model to simulate outcomes before committing to actions.

- *Planning as tree search:* MuZero-style planning [@schrittwieser2020mastering] with learned world models is structurally identical to tree search in agentic reasoning: both explore a tree of possibilities, evaluate states, and select the most promising path. Tree-of-Thought [@yao2023tree], RAP [@hao2023reasoning], and LATS [@zhou2024lats] use the LLM itself as a "world model" that predicts the consequences of reasoning steps.
- *Information world models:* Agentic search can be viewed as building a **world model of the information landscape**, understanding what information exists, where it is located, how it is structured, and how to access it efficiently. The dynamics model in world model RL (predicting the next state given an action) is analogous to the retrieval model in agentic search (predicting what information will be returned given a query).
- *LLM-as-world-model:* The LLM-as-world-model hypothesis [@hao2023reasoning] (Chapter 2) connects directly to agentic search: if LLMs have implicitly learned world dynamics through text prediction, their chain-of-thought reasoning can be viewed as step-by-step simulation using this implicit world model. The quality of the LLM's internal "world model" determines its effectiveness as a search planner.
- *Simulation for planning:* Video world models that predict visual futures are analogous to search agents that predict what evidence will be found, both using simulation to reduce the cost of exploration.

*Takeaway:* Treat agentic search as model-based planning over an information world model, where the LLM's predictive quality is the binding constraint on search effectiveness.

**Efficient Architectures (Chapter 3):** The computational cost of agentic search is dominated by LLM inference calls, making efficiency a first-class concern:

- *Inference cost amplification:* An agent that issues 100 queries to an LLM during a single research task amplifies the cost of each query by the fan-out factor, making inference optimization (speculative decoding, KV-cache management, quantization from Chapter 3) directly impact the economic viability of agentic search.
- *Efficient embedding models:* The retrieval component of RAG systems depends on efficient embedding models for dense retrieval. The bi-encoder vs. cross-encoder tradeoff (ColBERT's late interaction [@khattab2020colbert] as a middle ground) directly affects search latency. Modern embedding models such as E5 [@wang2024e5], GTE [@li2023gte], and BGE [@xiao2024bge], trained with contrastive learning, provide better retrieval quality at manageable cost.
- *KV-cache reuse:* Multi-turn agentic conversations can reuse KV-cache across turns (RadixAttention in SGLang [@zheng2024sglang]), connecting serving system design to agentic workflow efficiency. For agents that maintain long conversations with tool calls, KV-cache management determines whether the system can maintain context or must re-process.
- *MoE for multi-capability agents:* MoE models are particularly relevant for agentic systems that must switch between different modes (retrieval, reasoning, generation, tool use), as different experts can specialize in different modes without proportional compute cost.
- *Batch inference for search:* The tree search methods in agentic reasoning require efficient batch inference for parallel candidate evaluation. Continuous batching and speculative decoding (Chapter 3) directly impact the throughput of search-based reasoning.

*Takeaway:* Agent fan-out multiplies inference cost (an agent issuing 100 LLM calls per task pays roughly 100x the single-query cost), so the embedding-model, KV-cache, and batching choices from Chapter 3 set the economic ceiling on agentic search.

**Continual Learning (Chapter 1):** Search agents that operate over extended periods face classic continual learning challenges:

- *Continual retrieval:* Retrieval indices must be updated as new documents are added or existing ones change, creating a **continual learning challenge for the retrieval component**: the retriever must incorporate new documents without degrading retrieval quality for existing queries. By analogy, this resembles a class-incremental learning setup [@delange2021continual], where each new document acts like a new class to be incorporated, though the framing is our own: the cited survey studies class-incremental classification rather than retrieval.
- *Knowledge consistency:* Knowledge editing in LLMs (ROME [@meng2022locating], MEMIT [@meng2023mass] from Chapter 1) connects to RAG systems where the model's parametric knowledge must be kept consistent with retrieved evidence. When parametric and retrieved knowledge conflict, the system must decide which to trust, a problem that Self-RAG [@asai2024selfrag] addresses through self-reflection tokens.
- *Strategy accumulation:* Self-improving search agents that learn from their search experiences (Reflexion [@shinn2023reflexion], Voyager [@voyager2023]) face the classic stability-plasticity tradeoff: how to accumulate effective search strategies without forgetting strategies that worked for previous types of questions. The episodic memory in Reflexion functions as a replay buffer that must be managed to avoid interference.
- *Continual alignment:* As search agents are continually updated with new capabilities, maintaining alignment properties (safety, truthfulness, helpfulness) across updates is a continual learning problem addressed by the techniques in Chapter 1.

*Takeaway:* A long-lived search agent is a continual learner on two fronts at once, its retrieval index and its accumulated strategies, so both inherit the stability-plasticity and interference problems studied in Chapter 1.

**Randomized Algorithms (Chapter 5):** Approximate nearest neighbor search, the computational backbone of dense retrieval in RAG systems, relies fundamentally on randomized data structures:

- *ANN search infrastructure:* Locality-sensitive hashing [@indyk1998approximate] enables sub-linear retrieval from billion-scale document collections. HNSW (Hierarchical Navigable Small World) graphs [@malkov2020hnsw] use randomized graph construction for efficient approximate nearest neighbor search, and FAISS [@johnson2021faiss] provides GPU-accelerated implementations for billion-scale vector search. The retrieval quality-speed tradeoff is directly determined by the approximation parameters of these randomized data structures.
- *Bloom filters for deduplication:* Bloom filters [@bloom1970space] enable efficient membership testing for deduplication of retrieved documents, preventing redundant processing in multi-step search. Agentic search systems that retrieve from large corpora use Bloom filters to track which documents have already been retrieved.
- *Sketching for efficiency:* Count-Min sketches [@cormode2005improved] can track query frequency distributions for cache optimization in retrieval systems. The streaming algorithms perspective from Chapter 5 provides the theoretical framework for processing retrieval results in a single pass with bounded memory, directly applicable to online index updates.
- *Random projections for embedding:* Random projections reduce the dimensionality of embedding spaces for efficient indexing, with the JL lemma [@johnson1984extensions] guaranteeing that pairwise Euclidean distances are approximately preserved. Whether this carries over to retrieval quality depends on the similarity metric and the learned representations in use, so distance preservation bounds the geometry but does not by itself certify recall.

*Takeaway:* Every scalability claim in dense retrieval bottoms out in a randomized data structure from Chapter 5, so the index's approximation parameters (not the embedding model alone) govern the recall-versus-latency operating point.
