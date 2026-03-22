---
sidebar_position: 8
title: "Continual Learning in Large Language Models"
---

# Continual Learning in Large Language Models

The advent of large language models (LLMs) has created new urgency and new challenges for continual learning [@jang2022towards, @scialom2025continual].

### Continual Pre-Training

LLMs are typically pre-trained on massive corpora and then adapted to downstream tasks. Continual pre-training -- updating the model on new data without full retraining -- is essential for keeping models current. Gupta et al. (2023) [@gupta2023continual] studied continual pre-training of LLMs and found that naive fine-tuning on new data causes significant forgetting of previously learned capabilities. They showed that replay of a small fraction of original pre-training data substantially mitigates this issue.

Ibrahim et al. (2024) [@ibrahim2024investigating] investigated continual pre-training at scale, demonstrating that learning rate re-warming combined with data mixing strategies can enable effective knowledge accumulation across multiple pre-training stages. Their work on the Llama model family showed that thoughtful continual pre-training can match or exceed the performance of training from scratch on the combined dataset.

### Continual Instruction Tuning

Wu et al. (2024) [@wu2024mitigating] addressed continual instruction tuning, where an LLM must learn to follow new types of instructions without forgetting how to handle previously learned instruction types. They proposed Self-Distillation for continual instruction tuning, using the model's own outputs as soft targets to preserve previous capabilities while learning new instruction-following abilities.

### Catastrophic Forgetting in RLHF

Reinforcement Learning from Human Feedback (RLHF) can itself induce forgetting of pre-training knowledge. The alignment tax -- degradation of general capabilities during alignment training -- is a form of catastrophic forgetting. Methods like PPO with KL penalties partially address this by constraining the fine-tuned model to stay close to the base model, but more principled continual learning approaches are needed [@luo2023empirical].

### Parameter-Efficient Approaches

Parameter-efficient fine-tuning (PEFT) methods like LoRA, adapters, and prompt tuning offer natural mechanisms for continual learning in LLMs. By learning small task-specific parameter additions while keeping the backbone frozen, PEFT methods can reduce forgetting. Recent work has explored composing multiple LoRA modules for multi-task continual learning [@wang2023orthogonal, @huang2024loramoe].
