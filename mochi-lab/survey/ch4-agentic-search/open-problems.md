---
sidebar_position: 12
title: "Open Problems & Future Directions"
---

## Open Problems & Future Directions

### Hallucination Mitigation in Retrieval-Augmented Systems

Even with retrieval augmentation, LLMs can generate content not supported by retrieved evidence -- a phenomenon called "retrieval-augmented hallucination" [@shi2024trusting]. This takes several forms: the model may ignore relevant retrieved passages and rely on (incorrect) parametric knowledge; it may misinterpret or distort the content of retrieved passages; or it may fabricate citations to nonexistent sources. FActScore [@min2023factscore] provides a methodology for measuring factual precision by decomposing outputs into atomic claims and verifying each. Key challenges include:

- **Faithful attribution:** Ensuring that every claim in the generated text is backed by a specific, cited source passage. Current systems often generate plausible-sounding claims that are not actually present in any cited source. Attribution evaluation requires comparing generated claims against source passages at a fine-grained level [@rashkin2023measuring]. FActScore (Min et al., 2023) [@min2023factscore] introduced a methodology for decomposing long-form generations into atomic facts and verifying each against a knowledge source, providing a more granular measure of factual precision than traditional metrics.
- **Handling conflicting evidence:** When retrieved sources disagree (which is common for controversial or evolving topics), the system must acknowledge the disagreement rather than arbitrarily selecting one perspective. Current systems tend to present one source's view as fact, ignoring contradictions.
- **Knowing what you don't know:** Recognizing when retrieved information is insufficient to answer the question, and explicitly communicating this to the user rather than generating a confident but unsupported answer.

### Search Cost Optimization

Agentic search can be expensive, involving many LLM calls and retrieval operations. A single deep research query may trigger hundreds of search API calls and process millions of tokens. Developing cost-aware search policies that optimize the quality-cost tradeoff is critical for practical deployment.

This connects to several classical problems: the **optimal stopping problem** (when has enough evidence been gathered?) [@ferguson2006optimal], the **explore-exploit tradeoff** (should the agent search for new information or synthesize what it already has?), and **value of information** (how much should the agent invest in acquiring additional evidence?). Formal frameworks from sequential analysis and Bayesian decision theory could provide principled solutions, but adapting them to the high-dimensional, partially observable setting of agentic search remains an open challenge.

**Budget-aware agents** that can adapt their search strategy to a given compute budget (simple questions get one search, complex questions get many) represent a practical direction. Early work on adaptive RAG [@jeong2024adaptive] routes queries to different retrieval strategies based on complexity, and reasoning models like o1 [@openai2024o1] demonstrate that allocating more compute to harder problems yields substantial accuracy gains, but more sophisticated budget-aware planning is needed.

### Attribution and Provenance

Users increasingly demand transparency about where information comes from. Building search systems that produce **verifiable attribution** -- traceable chains from generated claims to source documents with specific passages highlighted -- remains technically challenging, especially when answers synthesize information from multiple sources. Key requirements include:

- **Passage-level attribution:** Linking each claim to the specific passage (not just the document) that supports it
- **Multi-source synthesis attribution:** When a claim is derived from combining information from multiple sources, attributing it to all relevant sources
- **Attribution verification:** Automatically checking whether cited passages actually support the generated claims
- **Temporal attribution:** Indicating when information was published, enabling users to assess freshness

### Multi-Modal Agentic Search

Searching across modalities -- text, images, video, code, structured data, audio -- with a unified agent that can reason about multi-modal evidence is an emerging frontier. Current systems typically handle each modality separately, but many real-world information needs are inherently multi-modal. A question about a medical condition might require reading text descriptions, interpreting medical images, and analyzing patient data tables. Future agentic search systems must:

- Formulate queries appropriate to each modality (text queries for documents, visual queries for images, structured queries for databases)
- Interpret and reason about evidence across modalities
- Synthesize multi-modal evidence into coherent answers
- Handle cross-modal references (text referring to images, data tables supporting textual claims)

### Personalized and Conversational Search

Adapting search strategies to individual user preferences, expertise levels, and information needs -- without explicit preference elicitation -- is a largely unsolved problem. A medical professional and a patient asking the same question about a disease need very different types of information, at different levels of detail, from different types of sources. Personalized agentic search must learn user preferences from interaction history, adjust the depth and breadth of search accordingly, and present information at the appropriate level of expertise.

**Conversational search** extends this further: maintaining coherent search sessions across multiple turns, building on previous queries and results, and adapting the search strategy based on user feedback. This requires maintaining long-term context and understanding implicit references to previous turns.

### Trust, Safety, and Adversarial Robustness

As agentic search systems are deployed at scale, they become targets for adversarial manipulation. Web content can be crafted to mislead search agents (SEO spam, adversarial pages designed to inject false information into AI-generated answers). **Prompt injection attacks** can be embedded in web pages, causing the search agent to follow attacker instructions rather than the user's intent. Building robust agentic search systems that can resist these attacks while maintaining access to the open web is a critical safety challenge.

### From Search to Research

The most ambitious direction is evolving agentic search into **autonomous research** -- systems that can not only find and synthesize existing information but generate novel hypotheses, design experiments (computational or analytical), and evaluate their own conclusions against evidence. This requires the integration of search, reasoning, creativity, and self-criticism at a level that current systems are only beginning to approach. Early systems like STORM [@shao2024storm] and OpenAI Deep Research represent first steps, but they remain far from the level of autonomous intellectual inquiry needed for genuine research assistance. Embodied research agents like Voyager [@voyager2023] demonstrate that autonomous agents can accumulate skills and knowledge over time in simulated environments, but extending this to open-ended scientific research in the real world remains a grand challenge.
