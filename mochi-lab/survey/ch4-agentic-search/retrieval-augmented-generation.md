---
sidebar_position: 5
title: "Retrieval-Augmented Generation (RAG)"
---

## Retrieval-Augmented Generation (RAG)

RAG systems retrieve relevant documents and condition the LLM's generation on this retrieved context, grounding responses in external evidence. RAG has become the dominant paradigm for knowledge-intensive NLP tasks, offering a practical solution to LLM hallucination by anchoring generation in retrieved facts.

### Dense Retrieval Foundations

Before discussing RAG architectures, it is essential to understand the retrieval models that underpin them:

**Dense Passage Retrieval (DPR)** (Karpukhin et al., 2020) [@karpukhin2020dpr] replaced traditional sparse retrieval (BM25) with learned dense representations. DPR trains a bi-encoder that maps queries and passages to a shared embedding space, where relevance is measured by dot-product similarity. DPR significantly outperforms BM25 on open-domain question answering, demonstrating that learned representations capture semantic similarity beyond keyword matching.

**ColBERT** (Khattab and Zaharia, 2020) [@khattab2020colbert] introduced **late interaction** -- a middle ground between bi-encoders (fast but limited interaction) and cross-encoders (expressive but slow). ColBERT computes per-token embeddings for queries and documents independently, then scores relevance through a MaxSim operation (max similarity between each query token and all document tokens). ColBERTv2 [@santhanam2022colbertv2] improved this with residual compression, enabling efficient storage and retrieval of millions of documents. The late interaction paradigm achieves near-cross-encoder quality with near-bi-encoder speed.

**Modern Embedding Models:** The latest generation of retrieval models (E5 [@wang2024e5], GTE [@li2023gte], BGE [@xiao2024bge], Gecko [@lee2024gecko]) use LLM-scale pre-training for embedding, achieving substantially better retrieval quality than earlier dense retrievers. These models are trained with multi-stage contrastive learning (weak supervision from web data, then hard negative mining) and support instructions that adapt the embedding to specific retrieval tasks.

### REALM

Guu et al. (2020) [@guu2020realm] proposed REALM (Retrieval-Augmented Language Model), which jointly pre-trains a retriever and a language model. The retriever is treated as a latent variable, and the entire system is trained end-to-end using the language modeling objective -- the model must learn to retrieve documents that help it predict masked tokens. REALM demonstrated that incorporating retrieval into pre-training produces models with better factual knowledge and improved downstream task performance, establishing the principle of end-to-end retrieval-language model training.

### RAG (Lewis et al.)

Lewis et al. (2020) [@lewis2020rag] introduced the RAG framework, combining a pre-trained retriever (DPR) with a pre-trained seq2seq generator (BART). RAG retrieves relevant passages for each input and conditions generation on them, with two variants: RAG-Token (retrieves separately for each output token, enabling different evidence for different parts of the answer) and RAG-Sequence (retrieves once for the entire output, using the same evidence throughout). RAG established the foundational architecture that most subsequent retrieval-augmented systems build upon.

### RETRO

Borgeaud et al. (2022) [@borgeaud2022retro] proposed RETRO (Retrieval-Enhanced Transformer), which scales retrieval augmentation to trillions of tokens. RETRO retrieves chunks from a massive database (2 trillion tokens from the MassiveText corpus) at each layer of the transformer using cross-attention. The key result: RETRO with 7B parameters achieves performance comparable to a 25x larger model (175B) without retrieval on several benchmarks. RETRO demonstrated that **retrieval can substitute for parametric scale**, offering a more efficient path to knowledge-intensive performance. This has profound implications for the scaling debate: instead of making models larger, make them better at looking things up.

### Atlas

Izacard et al. (2023) [@izacard2023atlas] introduced Atlas, which jointly trains a retriever and language model with few-shot learning capabilities. Atlas matches the performance of 540B-parameter PaLM on knowledge-intensive tasks using only 11B parameters -- a 50x parameter efficiency improvement. Atlas achieves this through joint training of the retriever and generator, where the retriever learns to find the specific passages needed by the generator for each query. Atlas demonstrated that the combination of a good retriever and a moderate-size generator can match or exceed much larger models that rely purely on parametric knowledge.

### Self-RAG

Asai et al. (2024) [@asai2024selfrag] proposed Self-RAG, which trains an LLM to adaptively retrieve, generate, and self-reflect. Unlike standard RAG (which always retrieves), Self-RAG learns special "reflection tokens" that serve three functions: (1) **[Retrieve]** determines whether retrieval is needed for the current generation step, (2) **[IsRel]** evaluates whether retrieved passages are relevant, and (3) **[IsSup]** assesses whether the generated response is supported by the retrieved evidence. This self-reflective approach reduces unnecessary retrieval (saving compute when the model is confident) and improves factual accuracy (by verifying that generated claims are grounded in evidence).

### Advanced RAG Architectures

**GraphRAG** (Edge et al., 2024) [@edge2024graphrag] introduced a graph-based approach to RAG that builds a knowledge graph from the document corpus and uses community detection and graph summarization to support both specific questions (answered by individual facts) and broad questions (answered by themes across the corpus). GraphRAG outperforms baseline RAG on holistic questions that require synthesizing information across many documents, a setting where standard chunk-based retrieval struggles.

**Corrective RAG (CRAG)** (Yan et al., 2024) [@yan2024crag] proposed a method that evaluates and corrects retrieved documents before using them for generation. CRAG uses a lightweight retrieval evaluator to assess document quality and triggers web search as a backup when the initial retrieval is inadequate. This corrective mechanism significantly improves RAG robustness on questions where the initial retrieval returns irrelevant or partially relevant documents.

**Modular RAG:** The field is evolving toward modular RAG architectures that decompose the pipeline into interchangeable components (query processing, retrieval, reranking, filtering, generation, verification), each of which can be independently optimized or replaced [@gao2024modular_rag]. This modularity enables domain-specific customization and systematic improvement of individual components.
