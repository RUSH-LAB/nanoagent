---
sidebar_position: 8
title: "World Models for Reasoning"
---

# World Models for Reasoning

An increasingly important direction connects world models to reasoning and language understanding. Rather than viewing world models purely as tools for RL-based control, this perspective sees world models as the substrate for general intelligence -- enabling agents to reason about causation, predict consequences, and plan in abstract spaces.

### LLM-as-World-Model

An emerging and provocative perspective treats large language models themselves as world models that have implicitly learned dynamics of the world through text prediction [@hao2023reasoning, @guan2023leveraging]. The argument is that by predicting the next token in vast text corpora -- which describe physical processes, causal relationships, and sequential events -- LLMs have been forced to build internal models of how the world works. Evidence for this view includes LLMs' ability to:
- Predict the outcomes of physical interactions (e.g., "what happens if you drop a glass?")
- Reason about spatial relationships and navigation
- Simulate board games and simple physical systems step-by-step
- Generate plausible continuations of action sequences

However, the LLM-as-world-model hypothesis faces important critiques. LLMs' "world knowledge" is derived entirely from text, which is a lossy, biased, and incomplete representation of the physical world. They make systematic errors on spatial reasoning, physical prediction, and counterfactual reasoning that suggest their "world model" is more of a statistical pattern match than a genuine simulator [@mitchell2023debate]. The degree to which LLMs learn causal structure (rather than correlational patterns) remains actively debated.

**WorldGPT** (Ge et al., 2024) [@ge2024worldgpt] explicitly frames LLMs as multimodal world models, integrating visual and textual information for environment simulation. By conditioning a large multimodal model on both visual observations and text descriptions, WorldGPT can predict the visual consequences of described actions, bridging the gap between language-based and vision-based world modeling.

### Dynalang: Language-Grounded Dynamics

Lin et al. (2024) [@lin2024learning] proposed Dynalang, which learns to model the world with language. By integrating language annotations into a Dreamer-style world model (adding language as an additional observation modality), Dynalang can ground language understanding in environment dynamics. The model learns to use language for predicting future states and for planning, creating a tighter loop between language comprehension and world understanding.

The key result is that language-grounded world models outperform both language-free world models (which must infer task structure from observations alone) and language-conditioned policies (which do not predict future states). This suggests that language provides a useful inductive bias for world modeling, encoding high-level task structure and causal relationships that are difficult to learn from raw observations.

### World Models for Planning and Reasoning in Language

More broadly, there is growing interest in world models that operate on or are conditioned by structured language descriptions rather than (or in addition to) raw sensory inputs [@wong2023word]. These models can leverage the compositional structure of language to generalize to novel situations described in natural language. This connects to the "language of thought" hypothesis in cognitive science: that humans reason about the world using an internal symbolic language, which may be analogous to how language-conditioned world models operate.

### Reasoning as Internal Simulation

The relationship between world models and reasoning can be understood through the lens of **simulation theory** [@craik1943nature]: reasoning is the process of running internal simulations and evaluating their outcomes. Chain-of-thought reasoning in LLMs can be viewed as a form of step-by-step simulation, where each reasoning step predicts the outcome of a mental action. This perspective suggests that improving LLMs' reasoning capabilities may require giving them better internal world models -- more accurate simulators of causal processes, physical dynamics, and logical inference.

The convergence of world models (from the RL community) and reasoning (from the NLP community) represents one of the most exciting frontiers in AI research. If these approaches can be unified -- giving language models access to learned physical simulators, and giving world models access to the compositional reasoning capabilities of language -- the resulting systems could achieve a new level of general intelligence.
