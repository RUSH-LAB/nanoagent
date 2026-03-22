---
sidebar_position: 6
title: "Architecture-Based Methods"
---

# Architecture-Based Methods

Architecture-based approaches prevent forgetting by design, either by freezing subsets of parameters or by dynamically expanding the network.

### Progressive Neural Networks

Rusu et al. (2016) [@rusu2016progressive] proposed Progressive Neural Networks (PNN), which allocate a new column of network parameters for each task while freezing all previous columns. Lateral connections from old columns to new ones enable forward transfer. PNN completely eliminates forgetting but at the cost of linearly growing model size and inability to share parameters across tasks efficiently.

### Dynamically Expandable Networks (DEN)

Yoon et al. (2018) [@yoon2018lifelong] proposed DEN, which selectively retrains and expands the network based on task demands. DEN first tries to learn new tasks using existing capacity, then adds neurons only when performance is insufficient. A group sparsity regularizer encourages parameter sharing across tasks, leading to more compact models than PNN.

### PackNet

Mallya and Lazebnik (2018) [@mallya2018packnet] proposed PackNet, which uses iterative pruning to identify and freeze subnetworks for each task within a fixed-size network. After training on a task, unimportant weights are pruned and the remaining weights are frozen. New tasks use the pruned (freed) weights. PackNet achieves zero forgetting with constant model size but has limited capacity determined by the pruning ratio and number of tasks.

### Hard Attention to the Task (HAT)

Serra et al. (2018) [@serra2018overcoming] proposed HAT, which learns task-specific attention masks over units in each layer. A learnable, nearly-binary mask determines which units are used for each task, and gradients are blocked from flowing through units important for previous tasks. HAT achieves near-zero forgetting with controlled capacity allocation.

### Supermasks in Superposition (SupSup)

Wortsman et al. (2020) [@wortsman2020supermasks] proposed SupSup, which maintains a randomly initialized, fixed backbone and learns binary supermasks for each task. At inference, the appropriate mask is applied to the fixed weights, effectively instantiating a task-specific subnetwork. SupSup can handle thousands of tasks with constant backbone size and zero forgetting, though performance depends on the backbone's capacity and the task similarity.

### Modular Networks and Mixture-of-Experts Approaches

Recent work has explored using Mixture-of-Experts (MoE) architectures for continual learning. Expert gates can route inputs to task-specific expert modules, with new experts added for new tasks while old experts are frozen [@aljundi2017expert]. This approach connects continual learning to efficient architecture design (see Chapter 3).
