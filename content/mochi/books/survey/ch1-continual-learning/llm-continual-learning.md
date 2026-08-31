---
sidebar_position: 8
title: "Continual Learning in Large Language Models"
---

# Continual Learning in Large Language Models

The advent of large language models (LLMs) has created both new urgency and fundamentally new challenges for continual learning [@jang2022towards, @scialom2025continual, @wu2024continual_llm_survey]. LLMs encode vast world knowledge in their parameters, and this knowledge must be updated as the world changes: new facts emerge, old facts become outdated, and new capabilities are required. Yet the cost of full retraining (tens of millions of dollars for frontier models) makes incremental updates essential. This section surveys the intersection of continual learning with LLMs, organized by the stage of the LLM lifecycle where continual learning is applied.

## Continual Pre-Training

LLMs are typically pre-trained on massive corpora and then adapted to downstream tasks. Continual pre-training (updating the model on new data without full retraining) is essential for keeping models current with evolving world knowledge, new languages, and domain-specific content.

### Data Mixing and Replay

Gupta et al. (2023) [@gupta2023continual] conducted a systematic study of continual pre-training of LLMs and found that naive fine-tuning on new data causes significant forgetting of previously learned capabilities. Critically, they showed that replaying a small fraction (as little as 1-5%) of original pre-training data substantially mitigates this issue, echoing findings from the classical continual learning literature. The key practical insight is that retaining a small, diverse sample of original training data is far cheaper than full retraining and sufficient to prevent catastrophic loss of general capabilities.

### Learning Rate Schedules

Gupta et al. (2023) [@gupta2023continual] showed that the learning rate schedule is one of the most critical design choices, introducing **learning rate re-warming**: resetting the learning rate to a moderate value at the start of each new pre-training stage, rather than continuing from the decayed rate. Building on this, Ibrahim et al. (2024) [@ibrahim2024investigating] investigated continual pre-training at scale and demonstrated that combining re-warming with re-decaying of the learning rate and a small fraction of replay enables effective knowledge accumulation across multiple pre-training stages. Their experiments (on models of 405M and 10B parameters) showed that this recipe can match the performance of training from scratch on the combined dataset, while using a fraction of the compute.

### Domain-Adaptive Pre-Training

A common application of continual pre-training is adapting a general-purpose LLM to a specific domain (e.g., biomedicine, law, finance). Gururangan et al. (2020) [@gururangan2020dont] showed that domain-adaptive pre-training (DAPT) on domain-specific corpora significantly improves downstream task performance, and that this adaptation can be done continually as new domain data becomes available. The challenge is maintaining general capabilities while acquiring domain expertise, a classic stability-plasticity tradeoff applied to LLMs.

## Continual Instruction Tuning

### Sequential Instruction Learning

Wu et al. (2024) [@wu2024mitigating] addressed continual instruction tuning, where an LLM must learn to follow new types of instructions without forgetting how to handle previously learned instruction types. They proposed Self-Distillation for continual instruction tuning, using the model's own outputs as soft targets to preserve previous capabilities while learning new instruction-following abilities. The self-distillation approach is practical because it does not require storing previous task data; the model itself serves as the "memory" of its previous capabilities.

### Continual Alignment

Reinforcement Learning from Human Feedback (RLHF) and related alignment methods can themselves induce forgetting of pre-training knowledge. The **alignment tax** (degradation of general capabilities during alignment training) is a form of catastrophic forgetting that has been observed across model families [@luo2023empirical]. Methods like PPO with KL penalties partially address this by constraining the fine-tuned model to stay close to the base model in distribution space, but more principled continual learning approaches are needed. DPO (Direct Preference Optimization) [@rafailov2023direct] implicitly constrains the updated model through the KL term in its objective, providing a form of regularization against forgetting.

As models are continually updated with new human feedback (incorporating new safety guidelines, correcting biases, or adapting to new use cases), the challenge of maintaining existing alignment properties while adding new ones becomes a continual learning problem. Methods from the CL literature (replay of previous preference data, regularization to preserve alignment properties) are increasingly applied to this setting.

## Knowledge Editing

A closely related problem is **knowledge editing**: updating specific facts in an LLM (e.g., changing the president of a country) without affecting other knowledge [@yao2023editing]. While not traditionally framed as continual learning, knowledge editing faces identical challenges: modifying the model's knowledge about one fact risks corrupting knowledge about related facts.

### Model Editor Networks

Approaches to knowledge editing include: (1) **locate-and-edit** methods like ROME [@meng2022locating] and MEMIT [@meng2023mass], which identify specific neurons or parameter updates responsible for a fact and modify them surgically; (2) **meta-learning editors** like MEND [@mitchell2022fast], which train a small editor network to produce parameter updates for specific knowledge changes; and (3) **retrieval-augmented approaches** that externalize knowledge to a database and update the database rather than the model.

The scalability of knowledge editing to many simultaneous edits is an active research area. While single edits can be performed reliably, hundreds or thousands of edits tend to degrade model quality, revealing the same capacity saturation problem seen in regularization-based continual learning [@hoelscher2023detecting].

## Parameter-Efficient Continual Learning

Parameter-efficient fine-tuning (PEFT) methods offer natural mechanisms for continual learning in LLMs, as they modify only a small fraction of the model's parameters while keeping the majority frozen.

### LoRA-Based Continual Learning

LoRA (Low-Rank Adaptation) [@hu2022lora] adds low-rank update matrices to the model's weights, training only these small additions. For continual learning, the simplest approach is to train a separate LoRA module for each task and merge or compose them at inference. Wang et al. (2023) [@wang2023orthogonal] proposed O-LoRA (Orthogonal Low-Rank Adaptation), which constrains each new LoRA module to be orthogonal to previous ones, preventing interference in the low-rank subspace. Huang et al. (2024) [@huang2024loramoe] proposed LoRAMoE, which combines multiple LoRA modules in a Mixture-of-Experts framework, routing inputs to the most relevant LoRA module.

### Adapter-Based Continual Learning

Adapter modules [@houlsby2019parameter] provide another PEFT mechanism suitable for continual learning. AdapterCL [@madotto2021continual] trains task-specific adapters while keeping the backbone frozen, achieving strong continual learning performance with minimal parameter overhead. The advantage of adapters over LoRA for continual learning is that adapters can be modularly composed and independently managed, making it straightforward to add, remove, or update individual task capabilities.

## Model Merging

An emerging approach to continual learning for LLMs is **model merging**: combining the parameters of models that have been independently fine-tuned on different tasks into a single model that performs well on all tasks.

### Task Arithmetic

Ilharco et al. (2023) [@ilharco2023editing] introduced Task Arithmetic, which computes "task vectors" as the difference between a fine-tuned model and the base model, and combines these vectors through simple arithmetic (addition, subtraction, scaling). By adding task vectors for multiple tasks, a single model can acquire capabilities from multiple independently fine-tuned models without any additional training. This approach is remarkable in its simplicity and connects to linear mode connectivity in loss landscapes.

### TIES-Merging and DARE

Yadav et al. (2024) [@yadav2024ties] proposed TIES-Merging (TrIm, Elect Sign & Merge), which addresses the sign conflicts that arise when naively averaging task vectors. TIES-Merging trims redundant parameters, resolves sign conflicts by majority vote, and merges only the agreed-upon parameters. Yu et al. (2024) [@yu2024language_dare] proposed DARE (Drop And REscale), which randomly drops a large fraction of delta parameters before merging, finding that 90-99% of fine-tuning delta parameters can be dropped without significant performance loss. Both methods improve upon simple averaging and enable combining more tasks without interference.

### Model Soups

Wortsman et al. (2022) [@wortsman2022model_soups] proposed Model Soups, which averages the weights of models fine-tuned with different hyperparameters. This simple averaging (or greedy selection of models to average) often improves both accuracy and robustness compared to any individual fine-tuned model. Model Soups exploit the fact that models fine-tuned from the same pre-trained initialization tend to lie in the same loss basin, making weight averaging effective.

The model merging paradigm represents a fundamentally different approach to continual learning: instead of training a single model sequentially on tasks, each task is trained independently and the results are combined post-hoc. This eliminates forgetting by construction (each task sees only its own data) and is embarrassingly parallel (tasks can be fine-tuned simultaneously). However, the quality of the merged model depends on the compatibility of the individually learned task representations, and the theoretical understanding of when and why model merging works is still developing.
