---
sidebar_position: 7.5
title: "Prompt-Based Continual Learning"
---

# Prompt-Based Continual Learning

The advent of large pre-trained vision transformers (ViT) [@dosovitskiy2021image] and language models has enabled a fundamentally new paradigm for continual learning: rather than modifying model weights (which risks forgetting), these methods learn small, task-specific **prompts** -- learnable parameters prepended to the input or injected into intermediate layers -- while keeping the pre-trained backbone entirely frozen. This approach achieves near-zero forgetting by construction (the backbone weights never change) while maintaining plasticity through the learned prompts. Prompt-based continual learning has rapidly become the dominant approach for continual learning with pre-trained models, achieving state-of-the-art results on standard benchmarks.

### Learning to Prompt (L2P)

Wang et al. (2022) [@wang2022learning_l2p] proposed L2P (Learning to Prompt for Continual Learning), the first method to apply prompt-based learning to continual learning. L2P maintains a **prompt pool** -- a set of learnable prompt vectors stored in memory -- and a query mechanism that selects relevant prompts for each input. Given an input image, L2P uses the frozen pre-trained model's features to query the prompt pool (via key-value matching), retrieves the top-K most relevant prompts, and prepends them to the input before passing through the frozen ViT.

The key insight is that by keeping the backbone frozen and learning only the prompts, forgetting is fundamentally prevented at the backbone level. The prompt pool serves as an external memory that can grow or be shared across tasks. L2P demonstrated strong performance on Split-CIFAR-100 and Split-ImageNet-R, significantly outperforming methods that fine-tune the backbone, while using far fewer trainable parameters. However, L2P does not explicitly model the distinction between task-shared and task-specific knowledge, and the prompt selection mechanism can struggle when tasks have overlapping feature requirements.

### DualPrompt

Wang et al. (2022) [@wang2022dualprompt] proposed DualPrompt, which extends L2P by explicitly separating prompts into two types: **general prompts** (G-Prompt) that capture task-invariant knowledge and are shared across all tasks, and **expert prompts** (E-Prompt) that capture task-specific knowledge and are selected per input. General prompts are attached to the earlier layers of the ViT (capturing low-level, task-invariant features), while expert prompts are attached to later layers (capturing high-level, task-specific features).

This separation is inspired by the neuroscience principle that lower-level cortical representations are shared across tasks while higher-level representations are more task-specific. DualPrompt achieves consistently better performance than L2P, particularly on long task sequences, because the explicit separation of shared and task-specific knowledge enables more efficient use of the prompt capacity. On Split-ImageNet-R with 10 tasks, DualPrompt achieves 68.13% average accuracy compared to L2P's 61.57%.

### S-Prompts

Wang et al. (2022) [@wang2022sprompts] proposed S-Prompts (S-liPrompts), which takes a simpler approach: learn a completely separate set of prompts for each task, with no sharing. At test time, S-Prompts uses K-means clustering in the feature space to identify which task an input likely belongs to, then applies the corresponding task-specific prompts. Despite its simplicity, S-Prompts achieves competitive performance with more complex methods, suggesting that when the pre-trained backbone is strong enough, the benefits of cross-task prompt sharing may be limited. S-Prompts also benefits from being able to train each task's prompts independently, without worrying about interference.

### CODA-Prompt

Smith et al. (2023) [@smith2023codaprompt] proposed CODA-Prompt (COntinual Decomposed Attention-based Prompting), which represents the state of the art in prompt-based continual learning. Rather than selecting discrete prompts from a pool (as in L2P) or maintaining separate prompts per task (as in S-Prompts), CODA-Prompt learns a set of prompt components that are combined via attention-based weighting. Each input generates attention weights over the prompt components, producing a continuous, input-dependent prompt.

The key innovation is that this attention-based composition allows the prompt to be both task-specific (different inputs weight the components differently) and continuously shareable (components are shared across tasks, with the composition varying). CODA-Prompt also introduces an orthogonality constraint between the prompt components learned for different tasks, reducing interference. On Split-ImageNet-R, CODA-Prompt achieves 72.80% average accuracy, substantially outperforming L2P (61.57%) and DualPrompt (68.13%).

### HiDe-Prompt

Wang et al. (2024) [@wang2024hierarchical_hide] proposed HiDe-Prompt (Hierarchical Decomposition Prompt), which further refines the prompt-based approach by decomposing prompts into a hierarchy of components at different levels of abstraction. HiDe-Prompt introduces task-level statistics (mean and covariance of features per task) to guide prompt selection and uses a Mahalanobis distance-based task identification mechanism that is more robust than the cosine similarity used in earlier methods.

### Prompt-Based Methods: Analysis and Limitations

The rapid success of prompt-based methods has raised important questions about what they actually learn and when they fail:

1. **Dependence on pre-training quality:** Prompt-based methods are only as good as the pre-trained backbone. On domains far from the pre-training distribution (e.g., medical imaging, satellite imagery), the frozen features may not be sufficient, and prompt tuning alone cannot compensate for inadequate representations.

2. **Task-identity inference:** Most prompt-based methods must infer which prompts to use at test time, and this inference can fail when tasks are very similar or when the feature distributions overlap. The robustness of task inference is a key differentiator between methods.

3. **Comparison fairness:** Some researchers have argued that comparing prompt-based methods (which use a large pre-trained backbone) against methods that learn from scratch is inherently unfair, as the pre-trained model already contains extensive world knowledge [@kim2023achieving]. Benchmarks specifically designed for pre-trained model continual learning are needed.

4. **Limited plasticity:** Because the backbone is frozen, prompt-based methods have limited capacity for learning truly novel representations that are not already encoded in the pre-trained model. For tasks requiring fundamentally new features, some backbone adaptation may be necessary.
