---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

# Taxonomy of Approaches

Continual learning methods can be organized into five major families [@masana2023class, @wang2024comprehensive]:

1. **Regularization-based methods** add penalty terms to the loss function that discourage changes to parameters important for previous tasks. This family includes weight regularization (EWC [@kirkpatrick2017overcoming], SI [@zenke2017continual], MAS [@aljundi2018memory]) and functional regularization (LwF [@li2017learning], PODNet [@douillard2020podnet], knowledge distillation [@hinton2015distilling]). Regularization methods are memory-efficient (no data storage needed) but suffer from capacity saturation on long task sequences: as more tasks are learned, the feasible region of parameter space that satisfies all constraints shrinks, eventually leaving insufficient capacity for new learning [@hsu2018reevaluating].

2. **Replay-based methods** store or generate exemplars from previous tasks and interleave them with new task data during training. This family includes experience replay with stored exemplars (ER [@chaudhry2019tiny], GEM [@lopezpaz2017gradient], DER++ [@buzzega2020dark]), generative replay using learned generative models (DGR [@shin2017continual], DDGR [@gao2023ddgr]), and compressed replay approaches (REMIND [@hayes2020remind]). Replay methods are currently the dominant paradigm, consistently achieving state-of-the-art results across settings [@buzzega2020dark, @boschini2022class] (see the Class-IL accuracy gaps reported in the Comparative Analysis below), but require storage of previous data which may conflict with privacy or memory constraints.

3. **Architecture-based methods** allocate dedicated parameters or subnetworks for each task, preventing interference by design. This family includes parameter isolation (PackNet [@mallya2018packnet], HAT [@serra2018overcoming], SupSup [@wortsman2020supermasks]), dynamic expansion (PNN [@rusu2016progressive], DEN [@yoon2018lifelong], FOSTER [@wang2022foster]), and modular networks [@mendez2022modular_cl]. Architecture methods achieve zero forgetting by construction but face challenges in scaling to many tasks and enabling backward transfer.

4. **Meta-learning-based methods** learn to learn continually, optimizing for the ability to quickly adapt to new tasks while retaining old knowledge. This family includes optimization-based meta-learning (OML [@javed2019meta], La-MAML [@gupta2020lamaml], ANML [@beaulieu2020learning]), building on the broader meta-learning framework [@hospedales2021metalearning, @finn2017model]. Meta-learning methods can achieve strong forward transfer but are computationally expensive during meta-training.

5. **Prompt-based methods** represent a new paradigm enabled by pre-trained vision transformers and large language models. Instead of modifying model weights, these methods learn task-specific prompts (small learnable parameters prepended to the input or hidden layers) while keeping the pre-trained backbone frozen. This family includes L2P [@wang2022learning_l2p], DualPrompt [@wang2022dualprompt], S-Prompts [@wang2022sprompts], and CODA-Prompt [@smith2023codaprompt]. Prompt-based methods achieve strong performance with minimal forgetting, as the backbone remains unchanged, but depend on the quality and generality of the pre-trained model.

These families are not mutually exclusive; many state-of-the-art methods combine elements from multiple families. For instance, DER++ combines replay with knowledge distillation (functional regularization) [@buzzega2020dark]; FOSTER combines dynamic architecture expansion with knowledge distillation [@wang2022foster]; Co2L combines contrastive replay with asymmetric knowledge distillation [@cha2021co2l]; and GPM [@saha2021gradient] combines gradient projection with experience replay. The trend in recent work is toward hybrid methods that leverage complementary strengths: regularization alone cannot prevent forgetting at scale, replay alone does not optimize the use of limited buffer capacity, and architecture methods alone do not enable backward transfer.

### Comparative Analysis Across Settings

The relative effectiveness of these families varies dramatically across settings [@vandeven2019three, @masana2023class]. In **Task-IL** (task identity provided at test time), regularization methods like EWC perform well because they can use task-specific output heads, reducing the problem to preserving shared representations. In **Class-IL** (no task identity), regularization methods fail dramatically because they cannot maintain a calibrated global decision boundary, and replay-based methods dominate. The gap is stark: on Seq-CIFAR-10 (Class-IL), DER++ with a 500-exemplar buffer reaches roughly 73% average accuracy, while pure regularization methods such as online EWC and SI collapse to about 19%, essentially the random-chance level for that setting [@buzzega2020dark]. In **Domain-IL**, both regularization and replay approaches are effective. This setting-dependence means that method claims must always be qualified by the evaluation setting: a method that "solves" continual learning in Task-IL may completely fail in Class-IL [@vandeven2019three].

### The Role of Pre-Training

A major shift in the continual learning landscape has been the move from learning representations from scratch to adapting pre-trained models. This shift is significant because pre-trained models already encode rich, general-purpose representations, fundamentally changing the nature of the continual learning problem. With a strong pre-trained backbone:

- **Forgetting is reduced** because the pre-trained features are already broadly useful, and fine-tuning from a good initialization tends to stay closer to it [@mehta2023empirical].
- **The capacity problem is alleviated** because the model starts with representations that are useful across many tasks, rather than having to carve out capacity for each new task.
- **New method families become possible** (prompt-based, adapter-based) that were not feasible without pre-training.

This has led some researchers to argue that continual learning with pre-trained models is a fundamentally different problem from continual learning from scratch [@lee2023pretrained], requiring different methods, benchmarks, and evaluation protocols. Lee et al. show empirically that algorithm rankings can change drastically once pre-training is introduced.
