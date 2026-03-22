---
sidebar_position: 13
title: "Connections to Other Chapters"
---

## Connections to Other Chapters

**World Models (Chapter 2):** World models enable agents to "search" through possible futures by simulating action outcomes. MuZero-style planning with learned world models is fundamentally a search problem. Agentic search can also be viewed as building a world model of the information landscape -- understanding what information exists, where it is, and how to access it.

**Efficient Architectures (Chapter 3):** The cost of agentic search is dominated by LLM inference calls. Efficient inference techniques (speculative decoding, KV-cache optimization, quantization) directly impact the feasibility of multi-step search. Additionally, efficient retrieval models (cross-encoders, bi-encoders, late interaction models) are critical for the retrieval component.

**Continual Learning (Chapter 1):** Search agents that operate over time must continually update their knowledge of available information sources, search strategies, and domain expertise. Retrieval indices must be updated as new documents are added, creating a continual learning challenge for the retrieval component.

**Randomized Algorithms (Chapter 5):** Approximate nearest neighbor search (the backbone of dense retrieval) relies on randomized data structures: locality-sensitive hashing, random projections, and randomized tree-based indices. The efficiency of vector search directly impacts the viability of retrieval-heavy agentic systems.
