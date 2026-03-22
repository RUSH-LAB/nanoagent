---
sidebar_position: 4
title: "Regularization Methods"
---

# Regularization Methods

Regularization-based approaches constrain weight updates to preserve knowledge encoded in parameters deemed important for previous tasks.

### Elastic Weight Consolidation (EWC)

Kirkpatrick et al. (2017) [@kirkpatrick2017overcoming] proposed EWC, drawing inspiration from synaptic consolidation in neuroscience. EWC adds a quadratic penalty to the loss function that penalizes changes to parameters proportional to their importance for previous tasks:

L_total = L_new(theta) + (lambda / 2) * sum_i F_i * (theta_i - theta_i^*)^2

where F_i is the diagonal of the Fisher information matrix (approximating parameter importance) and theta_i^* are the optimal parameters for the previous task. EWC demonstrated that selective parameter protection could substantially mitigate forgetting on sequential Atari game learning.

A key limitation of EWC is that the Fisher information approximation is only locally valid, and the quadratic penalty can become overly restrictive as the number of tasks grows. Online EWC [@schwarz2018progress] addresses the growing memory cost by maintaining a running sum of Fisher information matrices rather than storing one per task.

### Synaptic Intelligence (SI)

Zenke et al. (2017) [@zenke2017continual] proposed Synaptic Intelligence (SI), which computes parameter importance online during training rather than post-hoc. SI tracks the contribution of each parameter to the loss reduction along the entire training trajectory, yielding an importance measure that is both cheaper to compute and arguably more representative than the Fisher-based approximation of EWC. Empirical comparisons show SI and EWC perform comparably, with SI being more memory-efficient [@zenke2017continual].

### Learning without Forgetting (LwF)

Li and Hoiem (2017) [@li2017learning] introduced LwF, which uses knowledge distillation [@hinton2015distilling] to preserve the behavior of the network on old tasks while learning new ones. Rather than constraining parameters directly, LwF constrains the network's outputs: when training on new task data, it minimizes a distillation loss that encourages the network to produce the same outputs as the old model on the new task's inputs. This approach requires no stored exemplars from previous tasks but assumes that new task data is somewhat representative of previous input distributions.

### Memory Aware Synapses (MAS)

Aljundi et al. (2018) [@aljundi2018memory] proposed MAS, which estimates parameter importance based on the sensitivity of the learned function (rather than the loss) to parameter changes. This is computed as the magnitude of the gradient of the output with respect to each parameter, averaged over the data. MAS is task-agnostic and can be computed in an unsupervised manner, making it more flexible than EWC in settings where task boundaries are unclear.

### Limitations of Regularization Approaches

Regularization methods share a fundamental limitation: as the number of tasks grows, the feasible region of parameter space that satisfies all constraints shrinks, eventually leaving insufficient capacity for new learning [@hsu2018reevaluating]. This phenomenon, sometimes called "capacity saturation," means regularization methods tend to degrade on long task sequences. Additionally, these methods generally struggle with class-incremental learning, where task identity is not provided at test time [@vandeven2019three].
