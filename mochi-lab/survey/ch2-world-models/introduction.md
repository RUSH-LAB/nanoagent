---
sidebar_position: 1
title: "Introduction & Motivation"
---

# Introduction & Motivation

The concept of a world model -- an internal representation of how the environment works -- lies at the heart of intelligent behavior. Humans do not interact with the world purely through trial and error; instead, we simulate potential actions and their consequences in our minds before committing to a decision. This capacity for mental simulation, or "model-based" reasoning, is what allows us to plan, generalize, and adapt efficiently to novel situations [@craik1943nature, @johnsonlaird1983mental]. A child who has never pushed a glass off a table can predict that it will fall and break, because they have an internal model of gravity, fragility, and the consequences of actions on objects.

In artificial intelligence, world models formalize this idea: an agent learns a predictive model of its environment's dynamics, enabling it to plan and make decisions by "imagining" the outcomes of potential actions without executing them in the real world [@ha2018world, @hafner2019learning]. The idea has deep roots in model-based reinforcement learning, from the Dyna architecture [@sutton1990integrated] through Gaussian process dynamics models [@deisenroth2011pilco] to modern neural network-based approaches [@nagabandi2018neural, @chua2018deep]. The potential is transformative: a robot that can accurately predict the consequences of its actions in its "mind" before executing them can learn orders of magnitude more efficiently than one that must learn purely through physical trial and error. For a comprehensive survey of model-based RL, see Moerland et al. (2023) [@moerland2023model].

The seminal work of Ha and Schmidhuber (2018) [@ha2018world] crystallized the modern vision of world models for deep learning, building on Schmidhuber's earlier theoretical foundations for learning world models through compression and prediction [@schmidhuber2015learning]. Their three-component architecture -- a visual encoder (VAE), a dynamics model (MDN-RNN), and a compact controller -- established the template that subsequent work has refined and scaled.

The field has expanded dramatically since then, driven by five converging forces:

1. **Sample efficiency imperative.** Model-free reinforcement learning requires millions of real-world interactions to learn even simple behaviors, making it impractical for many real-world applications (especially robotics, where each interaction is slow and costly). World models offer a path to orders-of-magnitude improvements in sample efficiency by enabling "learning in imagination" -- training policies on model-generated trajectories rather than real experience [@hafner2020dream].

2. **Generative modeling advances.** The rapid progress in generative modeling -- from VAEs and GANs to diffusion models and autoregressive transformers -- has dramatically improved the fidelity of generated world simulations. Modern video generation models can produce photorealistic, temporally coherent sequences that serve as high-quality world simulators [@alonso2024diffusion, @valevski2024diffusion]. The evolution from early action-conditioned video prediction [@oh2015action, @finn2016unsupervised, @chiappa2017recurrent] to diffusion-based world models represents a qualitative leap in simulation fidelity.

3. **Foundation model paradigm.** The success of large pre-trained models in NLP and vision has raised the tantalizing possibility of **universal world models** -- foundation-scale models trained on broad data that can simulate diverse environments without domain-specific training [@bruce2024genie, @yang2023learning].

4. **Autonomous driving and robotics.** The autonomous driving industry has emerged as a major consumer and driver of world model research, using learned simulators for scenario generation, planning, and testing [@hu2023gaia1, @wang2024driving_world_survey]. Similarly, robotics has embraced world models for sim-to-real transfer and manipulation planning [@hansen2024tdmpc2].

5. **LLM-as-world-model hypothesis.** An emerging perspective suggests that large language models, trained to predict the next token on vast text corpora, have implicitly learned world models -- capturing the dynamics, physics, and causal structure of the world through the statistical patterns of language [@hao2023reasoning, @lecun2022path].

This chapter reviews the evolution of world models from classical approaches through modern foundation-scale systems. We organize the literature by application domain and architectural paradigm, covering latent-space and pixel-space models, video prediction, object-centric world models, foundation world models, robotics and autonomous driving applications, reasoning, and the intersection with reinforcement learning. Throughout, we trace the central tension between model fidelity (predicting everything accurately) and model utility (predicting only what matters for downstream tasks).
