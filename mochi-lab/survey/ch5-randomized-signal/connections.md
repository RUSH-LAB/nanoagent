---
sidebar_position: 15
title: "Connections to Other Chapters"
---

# Connections to Other Chapters

**Efficient Architecture Design (Chapter 3):** Many efficient architecture techniques are directly derived from the methods in this chapter. Linear attention uses random features for kernel approximation [@choromanski2021rethinking]; efficient attention uses sparse attention patterns analogous to locality-sensitive hashing; model compression uses randomized SVD and random projections; and state space models can be analyzed through spectral and signal processing lenses.

**Continual Learning (Chapter 1):** Randomized data structures underpin continual learning systems: reservoir sampling for replay buffers, sketching for compressed gradient storage, and random projections for computing parameter importance efficiently. The streaming algorithms perspective (processing data in a single pass with bounded memory) directly models the continual learning setting.

**World Models (Chapter 2):** Spectral methods can analyze the learned dynamics in world models; random projections can compress latent state representations; and randomized planning algorithms (random shooting, CEM with random sampling) are standard tools for planning with world models.

**Agentic Search (Chapter 4):** Approximate nearest neighbor search -- the backbone of dense retrieval in RAG systems -- relies heavily on LSH, random projections, and product quantization. The efficiency of vector databases that power agentic search systems directly depends on the randomized algorithms covered in this chapter.
