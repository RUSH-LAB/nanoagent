---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

# Taxonomy of Approaches

Continual learning methods can be organized into five major families [@parisi2019continual, @delange2021continual, @masana2023class, @wang2024comprehensive]:

1. **Regularization-based methods** add penalty terms to the loss function that discourage changes to parameters important for previous tasks. This family includes weight regularization (EWC, SI, MAS) and functional regularization (LwF, knowledge distillation). Regularization methods are memory-efficient (no data storage needed) but suffer from capacity saturation on long task sequences.

2. **Replay-based methods** store or generate exemplars from previous tasks and interleave them with new task data during training. This family includes experience replay with stored exemplars (ER, GEM, DER++), generative replay using learned generative models (DGR, DDGR), and pseudo-replay approaches. Replay methods are currently the dominant paradigm, consistently achieving state-of-the-art results across settings [@buzzega2020dark, @boschini2022class], but require storage of previous data which may conflict with privacy or memory constraints.

3. **Architecture-based methods** allocate dedicated parameters or subnetworks for each task, preventing interference by design. This family includes parameter isolation (PackNet, HAT, SupSup), dynamic expansion (PNN, DEN), and modular networks. Architecture methods achieve zero forgetting by construction but face challenges in scaling to many tasks and enabling knowledge transfer.

4. **Meta-learning-based methods** learn to learn continually, optimizing for the ability to quickly adapt to new tasks while retaining old knowledge. This family includes optimization-based meta-learning (OML, La-MAML, ANML) and metric-based approaches. Meta-learning methods can achieve strong forward transfer but are computationally expensive during meta-training.

5. **Prompt-based methods** represent a new paradigm enabled by pre-trained vision transformers and large language models. Instead of modifying model weights, these methods learn task-specific prompts (small learnable parameters prepended to the input or hidden layers) while keeping the pre-trained backbone frozen. This family includes L2P [@wang2022learning_l2p], DualPrompt [@wang2022dualprompt], S-Prompts [@wang2022sprompts], and CODA-Prompt [@smith2023codaprompt]. Prompt-based methods achieve strong performance with minimal forgetting, as the backbone remains unchanged, but depend on the quality and generality of the pre-trained model.

These families are not mutually exclusive; many state-of-the-art methods combine elements from multiple families. For instance, DER++ combines replay with knowledge distillation (functional regularization) [@buzzega2020dark]; FOSTER combines dynamic architecture expansion with knowledge distillation [@wang2022foster]; and Co2L combines contrastive replay with asymmetric knowledge distillation [@cha2021co2l]. The trend in recent work is toward hybrid methods that leverage complementary strengths.

### The Role of Pre-Training

A major shift in the continual learning landscape has been the move from learning representations from scratch to adapting pre-trained models. This shift is significant because pre-trained models already encode rich, general-purpose representations, fundamentally changing the nature of the continual learning problem. With a strong pre-trained backbone:

- **Forgetting is reduced** because the pre-trained features are already broadly useful, and fine-tuning from a good initialization tends to stay closer to it [@mehta2023empirical].
- **The capacity problem is alleviated** because the model starts with representations that are useful across many tasks, rather than having to carve out capacity for each new task.
- **New method families become possible** (prompt-based, adapter-based) that were not feasible without pre-training.

This has led some researchers to argue that continual learning with pre-trained models is a fundamentally different problem from continual learning from scratch [@kim2023achieving], requiring different methods, benchmarks, and evaluation protocols.
