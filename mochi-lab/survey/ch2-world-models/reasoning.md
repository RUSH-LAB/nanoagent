---
sidebar_position: 8
title: "World Models for Reasoning"
---

# World Models for Reasoning

### LLM-as-World-Model

An emerging perspective treats large language models themselves as world models that have implicitly learned dynamics of the world through text prediction [@hao2023reasoning, @guan2023leveraging]. LLMs can simulate physical processes, predict action outcomes, and reason about counterfactuals to a surprising degree. WorldGPT (Ge et al., 2024) [@ge2024worldgpt] explicitly frames LLMs as multimodal world models, integrating visual and textual information for environment simulation.

### Dynalang

Lin et al. (2024) [@lin2024learning] proposed Dynalang, which learns to model the world with language. By integrating language annotations into a Dreamer-style world model, Dynalang can ground language understanding in environment dynamics. The model learns to use language for predicting future states and for planning, creating a tighter loop between language comprehension and world understanding.

### Language-Grounded World Models

More broadly, there is growing interest in world models that operate on or are conditioned by structured language descriptions rather than (or in addition to) raw sensory inputs [@wong2023word]. These models can leverage the compositional structure of language to generalize to novel situations described in natural language.
