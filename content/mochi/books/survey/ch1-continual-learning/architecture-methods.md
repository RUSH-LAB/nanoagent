---
sidebar_position: 6
title: "Architecture-Based Methods"
---

# Architecture-Based Methods

Architecture-based approaches prevent forgetting by design, either by freezing subsets of parameters, isolating task-specific subnetworks, or dynamically expanding the network. The central principle is that by preventing parameter sharing between tasks (or carefully controlling it), interference between tasks is eliminated. This family achieves the strongest forgetting-prevention guarantees (many methods guarantee zero forgetting) at the cost of constraints on model growth, transfer, or capacity allocation. The zero-forgetting property is structural rather than empirical: it holds because old parameters are frozen under strict parameter isolation, which is also precisely why backward transfer is impossible in these methods.

This chapter focuses on methods that modify the base network architecture or allocate task-specific capacity within a shared backbone. Adapter-based continual learning for pre-trained models, which inserts small trainable adapter modules into frozen pre-trained backbones, is covered under prompt-based methods (see prompt-based-methods.md), as both adapters and prompts belong to the parameter-efficient fine-tuning family applied to pre-trained foundation models.

## Parameter Isolation Methods

### PackNet

Mallya and Lazebnik (2018) [@mallya2018packnet] proposed PackNet, which uses iterative pruning to identify and freeze subnetworks for each task within a fixed-size network. The procedure for each task is: (1) train the network using all available (unfrozen) parameters, (2) prune unimportant weights based on magnitude, and (3) freeze the remaining weights. New tasks use the pruned (freed) weights. PackNet achieves zero forgetting with constant model size, as each task's subnetwork is completely isolated. However, the total capacity is fixed and divided among tasks, so performance depends on the pruning ratio and the number of tasks: at some point, insufficient free parameters remain for new tasks.

### Hard Attention to the Task (HAT)

Serra et al. (2018) [@serra2018overcoming] proposed HAT, which learns task-specific attention masks over units in each layer. A learnable, nearly-binary mask (trained with an annealing sigmoid) determines which units are used for each task, and gradients are blocked from flowing through units important for previous tasks. HAT achieves near-zero forgetting with controlled capacity allocation and is more flexible than PackNet because the masks are learned (not pruned) and can partially overlap, enabling some parameter sharing between related tasks. The capacity allocation can be monitored and controlled through a mask sparsity regularizer.

### Supermasks in Superposition (SupSup)

Wortsman et al. (2020) [@wortsman2020supermasks] proposed SupSup, which maintains a randomly initialized, fixed backbone and learns binary supermasks for each task. At inference, the appropriate mask is applied to the fixed weights, effectively instantiating a task-specific subnetwork. The key insight, building on the Lottery Ticket Hypothesis [@frankle2019lottery], is that a sufficiently large random network contains good subnetworks for many different tasks, so the role of learning is just to find the right mask.

SupSup can handle thousands of tasks with constant backbone size and zero forgetting. When task identity is unknown, SupSup can infer it by trying each mask and selecting the one that produces the most confident prediction. However, the performance of each task-specific subnetwork is limited by the quality of the random backbone: it cannot match a network trained specifically for that task.

## Dynamic Expansion Methods

### Progressive Neural Networks (PNN)

Rusu et al. (2016) [@rusu2016progressive] proposed Progressive Neural Networks (PNN), the seminal dynamic expansion method. PNN allocates a new column of network parameters for each task while freezing all previous columns. Lateral connections from old columns to new ones enable forward transfer: the new column can access (but not modify) features from all previous tasks. PNN completely eliminates forgetting (frozen columns cannot change) and enables forward transfer (lateral connections), but at the cost of linearly growing model size: after T tasks, the model has T times the original size.

PNN's linear growth makes it impractical for long task sequences, but its conceptual framework (separate capacity for each task with controlled information flow between tasks) has been influential. Many subsequent methods can be viewed as addressing PNN's efficiency limitations.

### Dynamically Expandable Networks (DEN)

Yoon et al. (2018) [@yoon2018lifelong] proposed DEN, which selectively retrains and expands the network based on task demands. DEN first tries to learn new tasks using existing capacity (selective retraining), then adds neurons only when performance is insufficient (dynamic expansion). A group sparsity regularizer encourages parameter sharing across tasks, leading to more compact models than PNN. DEN also includes a split/duplication mechanism for neurons that have become too specialized for a single task. The result is a network that grows sub-linearly with the number of tasks, expanding only when truly needed.

### FOSTER: Feature Boosting and Compression

Wang et al. (2022) [@wang2022foster] proposed FOSTER, which combines dynamic expansion with compression in a principled way. For each new task, FOSTER (1) freezes the existing feature extractor, (2) adds a new lightweight feature extractor, (3) trains the new extractor to learn complementary features via a boosting-inspired objective, and (4) compresses the expanded model back to the original size using knowledge distillation. This "expand-then-compress" cycle achieves the benefits of expansion (dedicated capacity for new tasks) without the cost of permanent model growth.

To make these comparative claims concrete, FOSTER reports an average incremental accuracy of about 72.9% on CIFAR-100 in the class-incremental setting where all 100 classes are learned from scratch in 10 equal steps of 10 classes each (the CIFAR-100 B0, 10-step protocol). Under the harder regime that starts from 50 base classes and adds the remaining 50 in finer increments (the B50 protocol), the same method reports roughly 68.0% at 10 steps and 63.8% at 25 steps, illustrating how strongly reported numbers in this literature depend on the increment schedule. Such figures are only meaningful alongside their exact protocol, so comparisons across papers must hold the benchmark setting fixed.

### DER: Dynamically Expandable Representation

Yan et al. (2021) [@yan2021der_cl] proposed DER (not to be confused with Dark Experience Replay), which maintains a dynamically growing set of feature extractors. For each new task, a new feature extractor is added and trained while all previous extractors are frozen. An auxiliary loss ensures that the new extractor learns complementary features that are not redundant with existing ones. A unified classifier operates over the concatenated features from all extractors. To control the otherwise linear growth in capacity, DER applies a channel-level mask with a sparsity penalty that prunes redundant channels from each newly added extractor, keeping the effective parameter growth modest. This pruning step is DER's key efficiency mechanism and the natural point of comparison with the expand-then-compress methods.

### MEMO: A Unified Approach

Zhou et al. (2022) [@zhou2022memo] proposed MEMO (Memory-Efficient expandable MOdel), which makes dynamic expansion more parameter-efficient by decoupling the network into shared generalized (shallow) blocks and task-specific specialized (deep) blocks. Rather than expanding an entire feature extractor per task as in DER, MEMO keeps the shallow generalized blocks shared across tasks and expands only the deep specialized blocks, which substantially reduces the per-task parameter cost. MEMO's central contribution is a memory-aligned (or memory-efficient) fairness analysis: it argues that comparisons between continual learning methods should hold the total memory budget fixed, trading off model parameters against stored exemplars, and shows that this fair accounting changes which methods look best.

The dynamic-expansion family is best read as a sequence of answers to the same question: how to grow capacity for new tasks without paying unbounded parameter cost. PNN takes the simplest position (one frozen column per task, linear growth, but explicit forward transfer through lateral connections); DEN relaxes this to sub-linear growth by reusing existing capacity first and expanding only when needed; DER keeps DER-style per-task extractors but adds channel-level mask pruning to make that growth tractable; and FOSTER and MEMO push hardest on efficiency, with FOSTER using an expand-then-compress cycle that distills back to the original size and MEMO sharing the generalized blocks so that only specialized blocks expand. The recurring tradeoff is between forward transfer and added capacity on one side and parameter or memory cost on the other, with each method choosing a different point on that curve.

## Modular and Mixture-of-Experts Approaches

### Expert Gate

Aljundi et al. (2017) [@aljundi2017expert] proposed Expert Gate, which combines a set of expert networks (one per task) with a learned gating mechanism that selects the appropriate expert for each input. The gate is trained autoencodically to recognize which task's distribution an input belongs to. New experts are added for new tasks while old experts are frozen. Expert Gate eliminates forgetting by isolation and provides automatic task inference, but the linear growth in the number of experts limits scalability.

### Mixture-of-Experts for Continual Learning

Recent work has explored using Mixture-of-Experts (MoE) architectures for more efficient continual learning. Rather than one expert per task, MoE approaches maintain a shared pool of experts with learned routing, allowing multiple tasks to share experts while new experts can be added as needed [@yu2024boosting_moe_cl]. This connects continual learning to efficient architecture design (see Chapter 3) and offers a middle ground between full parameter isolation (zero interference but no sharing) and full parameter sharing (maximal sharing but maximal interference).

### Modular Networks and Composition

A related line of work explores modular architectures where skills are decomposed into reusable modules that can be composed for new tasks [@mendez2022modular_cl]. This compositional approach to continual learning has the appealing property of enabling combinatorial generalization: new tasks can be solved by composing previously learned modules in new ways, achieving both forward transfer and zero forgetting on the module level.

## Tradeoffs and Limitations

Architecture-based methods achieve the strongest forgetting guarantees in the continual learning toolbox, with many guaranteeing zero forgetting by construction (the parameter-isolation regime freezes old parameters, so forgetting and backward transfer are both ruled out). However, they face several limitations:

1. **Model growth:** Expansion methods increase model size with each task. Even sub-linear growth (DEN) eventually becomes impractical for hundreds or thousands of tasks.
2. **Limited backward transfer:** Because previous task parameters are frozen, learning new tasks cannot improve performance on old tasks. This limits the potential for knowledge accumulation.
3. **Task inference:** At test time, most architecture methods require knowing which task a sample belongs to (to select the right subnetwork or expert). Methods that can infer task identity (SupSup, Expert Gate) add complexity and may fail on ambiguous inputs.
4. **Parameter efficiency:** Parameter isolation methods (PackNet, HAT) divide a fixed model's capacity among tasks, limiting the capacity available to each. With many tasks, each task gets a thin slice of the network.
