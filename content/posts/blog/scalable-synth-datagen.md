---
slug: scalable-synth-datagen
title: "Scalable Synthetic Data Generation with LLMs"
authors: [zeyu]
tags: [llm, synthetic-data, data-generation]
---

Human data annotation is expensive, and projections suggest the stock of high-quality public text could be exhausted within this decade [@villalobos2024data]. Synthetic data lets you precisely target capability gaps. The question is not *whether* to use synthetic data, but *how* to do it without collapsing into repetitive, low-diversity slop. Here is a survey of the key paradigms and the best open-source tooling to put them into practice.

<!-- truncate -->

## Tooling: What to Actually Use

If you want to build a synthetic data pipeline today, start here.

[**distilabel**](https://github.com/argilla-io/distilabel) is the best all-around framework (as of mid-2024). It ships built-in implementations of Self-Instruct, Evol-Instruct, Magpie, UltraFeedback, DPO preference data, and LLM-as-Judge, with a composable pipeline architecture, automatic caching, and support for all major LLM backends (OpenAI, Anthropic, vLLM, Ollama, etc.). Integrates with Argilla for human review and Hugging Face Hub for dataset publishing. **If you only pick one tool, pick this one.**

[**NeMo Data Designer**](https://github.com/NVIDIA-NeMo/DataDesigner) is NVIDIA's enterprise alternative (as of late 2024). Statistical sampling for controlling field distributions, built-in validators for rejection sampling, tight integration with the Nemotron model family. Best if you are already in the NVIDIA ecosystem.

A few specialized tools worth knowing:

| Tool | What it does |
|---|---|
| [**Magpie**](https://github.com/magpie-align/magpie) | Extracts instruction-response pairs from instruct-tuned models with zero seed data by exploiting chat templates. Also a built-in task in distilabel. |
| [**Bonito**](https://github.com/BatsResearch/bonito) | Converts raw text into task-specific training pairs (QA, NLI, summarization) using its own open fine-tuned model rather than a proprietary API (`pip install bonito-llm`). |
| [**DataDreamer**](https://github.com/datadreamer-dev/DataDreamer) | Research-focused framework with automatic provenance tracking and reproducibility fingerprints ([ACL 2024](https://aclanthology.org/2024.acl-long.208/)). |

---

## The Paradigms

### Self-Instruct & Evol-Instruct

[**Self-Instruct**](https://arxiv.org/abs/2212.10560) bootstraps instruction-following data from a small seed set: the LLM generates new instructions, filters them, and produces input-output pairs. [**Evol-Instruct**](https://arxiv.org/abs/2304.12244) (WizardLM) takes this further by *evolving* instructions through complexity escalation, rewriting simple prompts into harder ones via depth evolution (add constraints, reasoning steps) and breadth evolution (diverse topics).

### Distillation

Use a frontier model to generate training data for a smaller model [@hinton2015distilling]. The key insight from [Orca](https://arxiv.org/abs/2306.02707) and the [Phi series](https://arxiv.org/abs/2306.11644): distill the *process* (chain-of-thought, tool use, planning), not just the *product*.

### Self-Play & Iterative Refinement

Models improve themselves through iterative interaction. [**SPIN**](https://arxiv.org/abs/2401.01335) frames training as a two-player self-play game: the model learns to distinguish its own prior-iteration outputs from human SFT data, with both the generator and the main player instantiated from the same LLM across iterations. **STaR** [@zelikman2022star] generates rationales, keeps the ones leading to correct answers, and trains on those.

### Constitutional AI & RLAIF

[Constitutional AI](https://arxiv.org/abs/2212.08073) generates critiques and revisions guided by principles, producing preference pairs for RLHF without human labelers. [RLAIF](https://arxiv.org/abs/2309.00267) generalizes this to use LLMs for the feedback signal.

### Persona-Driven Generation

[**Persona Hub**](https://arxiv.org/abs/2406.20094) creates a massive pool of diverse personas (1B+) and generates data from each perspective, a practical lever for the diversity problem. The authors report that a 7B model trained on Persona Hub math instructions reaches 64.9% on MATH, matching gpt-4-turbo-preview in their evaluation.

### Rejection Sampling

For domains with verifiable answers (math, code), generate N candidate solutions and keep only the correct ones. Simple and effective where a verifier exists, though it is limited to checkable domains and can narrow diversity by discarding everything but solutions that pass the check.

### RL with Verifiable Rewards

A direction that has produced strong recent results. **DeepSeek-R1** [@deepseekai2025r1] uses large-scale RL with rule-based verifiable rewards (correctness and format) optimized via GRPO [@shao2024deepseekmath]. Notably, the authors report that process reward models (PRMs) suffered from reward hacking in their setting, so they rely on outcome-level rewards rather than step-level feedback.

---

## Putting It Together

The current best practice combines multiple paradigms:

1. **Seed** with diverse personas and topics
2. **Evolve** complexity through iterative rewriting
3. **Generate at scale** with rejection sampling: overproduce and filter aggressively
4. **Verify** with code execution, math proofs, or factual grounding
5. **Iterate**: generate, train, generate better, repeat
6. **Align** with reward modeling on synthetic preferences

Common failure modes and mitigations:

| Failure Mode | Mitigation |
|---|---|
| Mode collapse | Persona diversity, temperature control, topic seeding |
| Hallucination | Grounding in retrieved docs, verification |
| Difficulty plateau | Evol-instruct, curriculum design |
| Style homogeneity | Multi-model ensemble, persona conditioning |
| Reward hacking | Multiple reward signals, OOD validation |

---

## Limitations

Each paradigm carries failure modes that the table above only summarizes. Distillation inherits the teacher's blind spots and licensing constraints, and a student can never exceed its teacher on capabilities the teacher lacks. Self-play and iterative refinement can amplify the model's own biases when there is no external signal, drifting toward a narrow distribution over rounds. Rejection sampling and RLVR are confined to domains with a cheap, reliable verifier; outside math and code, defining the reward is itself the hard problem, and rule-based rewards remain gameable. Persona-driven generation broadens surface diversity but does not guarantee semantic correctness, so it still needs downstream verification. The tooling notes are snapshots (dated where given) and feature sets move quickly, so check current release notes before committing to a stack.

---

The methods above range from established results (Self-Instruct, STaR, distillation, Constitutional AI) to active research directions whose tradeoffs are still being mapped (large-scale RLVR, persona-driven generation at extreme scale). My own read is that the frontier is moving from "prompt a model and collect outputs" toward "build autonomous data factories with verification loops," and that data quality is becoming as decisive as architecture. That last point is a prediction, not a settled finding.
