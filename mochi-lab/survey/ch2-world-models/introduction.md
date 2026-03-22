---
sidebar_position: 1
title: "Introduction & Motivation"
---

# Introduction & Motivation

The concept of a world model -- an internal representation of how the environment works -- lies at the heart of intelligent behavior. Humans do not interact with the world purely through trial and error; instead, we simulate potential actions and their consequences in our minds before committing to a decision. This capacity for mental simulation, or "model-based" reasoning, is what allows us to plan, generalize, and adapt efficiently to novel situations [@craik1943nature, @johnsonlaird1983mental].

In artificial intelligence, world models formalize this idea: an agent learns a predictive model of its environment's dynamics, enabling it to plan and make decisions by "imagining" the outcomes of potential actions without executing them in the real world [@ha2018world, @hafner2019learning]. The seminal work of Ha and Schmidhuber (2018) [@ha2018world] crystallized the modern vision of world models for deep learning, demonstrating that a compact latent-space model of environment dynamics could support effective policy learning in a "dream" environment.

The field has expanded dramatically since then. World models now span applications from game playing to robotics, from video generation to reasoning. Three key drivers have propelled this expansion. First, the computational cost of model-free reinforcement learning -- which requires millions of real-world interactions -- has made sample-efficient, model-based approaches increasingly attractive. Second, advances in generative modeling (VAEs, GANs, diffusion models, autoregressive transformers) have enabled much higher-fidelity world simulations. Third, the rise of foundation models has raised the tantalizing possibility of universal world models that generalize across domains.

This chapter reviews the evolution of world models from classical approaches through modern foundation-scale systems. We organize the literature by application domain and architectural paradigm, covering pixel-space and latent-space models, video prediction, foundation world models, robotics applications, reasoning, and the intersection with reinforcement learning.
