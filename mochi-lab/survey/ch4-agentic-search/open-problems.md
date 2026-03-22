---
sidebar_position: 12
title: "Open Problems & Future Directions"
---

## Open Problems & Future Directions

### Hallucination Mitigation

Even with retrieval augmentation, LLMs can generate content not supported by retrieved evidence -- "retrieval-augmented hallucination" [@shi2024trusting]. Key challenges include: faithful attribution (every claim backed by a cited source), handling conflicting evidence, and knowing when retrieved information is insufficient to answer the question.

### Search Cost Control

Agentic search can be expensive, involving many LLM calls and retrieval operations. Developing cost-aware search policies that optimize the quality-cost tradeoff is critical for practical deployment. This connects to the optimal stopping problem in statistics [@ferguson2006optimal].

### Attribution and Provenance

Users increasingly demand to know where information comes from. Building search systems that produce verifiable attribution -- traceable chains from claims to source documents -- remains technically challenging, especially when answers synthesize information from multiple sources [@rashkin2023measuring].

### Multi-Modal Search

Searching across modalities (text, images, video, code, structured data) with a unified agent that can reason about multi-modal evidence is an emerging frontier. Current systems typically handle each modality separately.

### Personalized Search

Adapting search strategies to individual user preferences, expertise levels, and information needs -- without explicit preference elicitation -- is a largely unsolved problem in the agentic search context.
