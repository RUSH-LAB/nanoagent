---
sidebar_position: 5
title: "Retrieval-Augmented Generation (RAG)"
---

## Retrieval-Augmented Generation (RAG)

RAG systems retrieve relevant documents and condition the LLM's generation on this retrieved context, grounding responses in external evidence.

### REALM

Guu et al. (2020) [@guu2020realm] proposed REALM (Retrieval-Augmented Language Model), which jointly pre-trains a retriever and a language model. The retriever is treated as a latent variable, and the entire system is trained end-to-end using the language modeling objective. REALM demonstrated that incorporating retrieval into pre-training produces models with better factual knowledge and improved downstream task performance.

### RAG (Lewis et al.)

Lewis et al. (2020) [@lewis2020rag] introduced the RAG framework, combining a pre-trained retriever (DPR) with a pre-trained seq2seq generator (BART). RAG retrieves relevant passages for each input and conditions generation on them, with two variants: RAG-Token (retrieves separately for each output token) and RAG-Sequence (retrieves once for the entire output). RAG established the foundational architecture that most subsequent retrieval-augmented systems build upon.

### RETRO

Borgeaud et al. (2022) [@borgeaud2022retro] proposed RETRO (Retrieval-Enhanced Transformer), which scales retrieval augmentation to trillions of tokens. RETRO retrieves chunks from a massive database at each layer of the transformer using cross-attention, achieving performance comparable to a 25x larger model without retrieval. RETRO demonstrated that retrieval can substitute for parametric scale, offering a more efficient path to knowledge-intensive performance.

### Atlas

Izacard et al. (2023) [@izacard2023atlas] introduced Atlas, which jointly trains a retriever and language model with few-shot learning capabilities. Atlas matches the performance of 540B-parameter PaLM on knowledge-intensive tasks using only 11B parameters, demonstrating the power of retrieval augmentation for parameter efficiency.

### Self-RAG

Asai et al. (2024) [@asai2024selfrag] proposed Self-RAG, which trains an LLM to adaptively retrieve, generate, and self-reflect. Unlike standard RAG, which always retrieves, Self-RAG learns special "reflection tokens" that determine when to retrieve, evaluate whether retrieved passages are relevant, and assess whether the generated response is supported by the evidence. This self-reflective approach reduces unnecessary retrieval and improves factual accuracy.
