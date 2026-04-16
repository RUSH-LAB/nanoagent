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

A compelling piece of evidence comes from **Othello-GPT** (Li et al., 2023) [@li2023emergent_othello], which trained a GPT model purely on sequences of Othello moves (no board state information) and discovered that the model's internal representations encode a linear representation of the board state. Probing revealed that the model learned the complete game dynamics -- legal moves, piece placement, and flipping rules -- purely from move sequences. This demonstrates that sequence prediction can give rise to genuine world models, at least in structured domains. The follow-up work by Neel Nanda et al. (2023) [@nanda2023emergent] used mechanistic interpretability to trace exactly how these world representations emerge in the model's circuits.

However, the LLM-as-world-model hypothesis faces important critiques. LLMs' "world knowledge" is derived entirely from text, which is a lossy, biased, and incomplete representation of the physical world. They make systematic errors on spatial reasoning, physical prediction, and counterfactual reasoning that suggest their "world model" is more of a statistical pattern match than a genuine simulator [@mitchell2023debate]. Gurnee and Tegmark (2024) [@gurnee2024language] found that LLMs develop linear representations of space and time within their activations, suggesting some genuine structure learning, but these representations remain fragile under distribution shift. The degree to which LLMs learn causal structure (rather than correlational patterns) remains actively debated.

**WorldGPT** (Ge et al., 2024) [@ge2024worldgpt] explicitly frames LLMs as multimodal world models, integrating visual and textual information for environment simulation. By conditioning a large multimodal model on both visual observations and text descriptions, WorldGPT can predict the visual consequences of described actions, bridging the gap between language-based and vision-based world modeling.

**Pre-Trained LMs for Decision-Making** (Li et al., 2023) [@li2023language] demonstrated that pre-trained language models can be directly used as interactive decision-making agents by representing states, actions, and goals as text. The language model's pre-trained knowledge of world dynamics (encoded in its weights from training on text describing physical and social interactions) provides a surprisingly effective prior for RL in text-based environments, supporting the view that LLMs encode implicit world models.

**Language Models Meet World Models** (Xiang et al., 2024) [@xiang2024language] proposed enhancing language models with embodied experiences -- training them not just on text but on interaction data from physical environments. The resulting models show improved reasoning about physical dynamics, spatial relationships, and action consequences, suggesting that grounding in embodied experience is necessary for truly robust world knowledge.

### Dynalang: Language-Grounded Dynamics

Lin et al. (2024) [@lin2024learning] proposed Dynalang, which learns to model the world with language. By integrating language annotations into a Dreamer-style world model (adding language as an additional observation modality), Dynalang can ground language understanding in environment dynamics. The model learns to use language for predicting future states and for planning, creating a tighter loop between language comprehension and world understanding.

The key result is that language-grounded world models outperform both language-free world models (which must infer task structure from observations alone) and language-conditioned policies (which do not predict future states). This suggests that language provides a useful inductive bias for world modeling, encoding high-level task structure and causal relationships that are difficult to learn from raw observations.

### World Models for Planning and Reasoning in Language

More broadly, there is growing interest in world models that operate on or are conditioned by structured language descriptions rather than (or in addition to) raw sensory inputs [@wong2023word]. These models can leverage the compositional structure of language to generalize to novel situations described in natural language. This connects to the "language of thought" hypothesis in cognitive science: that humans reason about the world using an internal symbolic language, which may be analogous to how language-conditioned world models operate.

**SayPlan** (Ahn et al., 2023) [@ahn2023sayplan] grounds LLM planning in 3D scene graphs, using the scene graph as an explicit world model that the LLM reasons over. By providing the LLM with a structured representation of the environment, SayPlan enables long-horizon task planning that is grounded in the actual physical layout. **Inner Monologue** (Huang et al., 2023) [@huang2023inner] uses verbal feedback from the environment (success detection, scene description, human feedback) to enable closed-loop LLM planning, where the LLM updates its internal world model based on observed outcomes. These approaches demonstrate that language provides a natural interface between world models and planning, enabling compositional reasoning about novel scenarios.

### Causal World Models

A distinct research direction pursues world models with explicit causal structure, going beyond the correlational patterns learned by standard predictive models. **CausalWorld** (Ahmed et al., 2020) [@ahmed2020causalworld] proposed a benchmark for causal structure and transfer in robotic manipulation, testing whether agents can identify causal relationships (e.g., pushing an object causes it to move) and generalize across environments with different causal structures. The key argument for causal world models is that correlational models fail under intervention -- when the agent takes a novel action that differs from the training distribution, a correlational model may produce incorrect predictions because it has not learned the underlying causal mechanism. Causal models, in contrast, can support counterfactual reasoning ("what would have happened if I had acted differently?"), which is essential for robust planning in novel situations.

### Reasoning as Internal Simulation

The relationship between world models and reasoning can be understood through the lens of **simulation theory** [@craik1943nature]: reasoning is the process of running internal simulations and evaluating their outcomes. Chain-of-thought reasoning in LLMs can be viewed as a form of step-by-step simulation, where each reasoning step predicts the outcome of a mental action. This perspective suggests that improving LLMs' reasoning capabilities may require giving them better internal world models -- more accurate simulators of causal processes, physical dynamics, and logical inference.

The convergence of world models (from the RL community) and reasoning (from the NLP community) represents one of the most exciting frontiers in AI research. If these approaches can be unified -- giving language models access to learned physical simulators, and giving world models access to the compositional reasoning capabilities of language -- the resulting systems could achieve a new level of general intelligence.
