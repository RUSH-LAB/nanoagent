---
sidebar_position: 2
---

# RL Algorithms for LLMs

## Background

Reinforcement learning from human feedback (RLHF) fine-tunes a pretrained language model $\pi_\theta$ using a reward signal. The standard pipeline is:

1. **SFT** — supervised fine-tuning on demonstration data to get $\pi_{\text{ref}}$.
2. **Reward model** — train $r_\phi(x, y)$ on human preference pairs.
3. **RL optimization** — maximize reward while staying close to $\pi_{\text{ref}}$.

The general objective is:

$$
\max_{\theta} \; \mathbb{E}_{x \sim \mathcal{D},\, y \sim \pi_\theta(\cdot|x)} \left[ r_\phi(x, y) \right] - \beta \, D_{\text{KL}}\!\left(\pi_\theta \| \pi_{\text{ref}}\right)
$$

The KL penalty prevents the policy from drifting too far from the reference and exploiting reward model errors.

## Standard RL

The simplest policy gradient method. The gradient of the expected reward is:

$$
\nabla_\theta J = \mathbb{E}_{\pi_\theta} \left[ \nabla_\theta \log \pi_\theta(y|x) \cdot R \right]
$$

where $R$ is the return. A **baseline** $b$ (e.g. average reward) reduces variance without introducing bias:

$$
\nabla_\theta J = \mathbb{E}_{\pi_\theta} \left[ \nabla_\theta \log \pi_\theta(y|x) \cdot (R - b) \right]
$$

**Limitation:** high variance, on-policy only (must discard samples after each update).

## PPO (Proximal Policy Optimization)

PPO constrains how much the policy can change per update using a clipped surrogate objective. Define the probability ratio:

$$
r_t(\theta) = \frac{\pi_\theta(a_t | s_t)}{\pi_{\theta_{\text{old}}}(a_t | s_t)}
$$

The clipped objective is:

$$
\mathcal{L}^{\text{CLIP}} = \mathbb{E}_t \left[ \min\!\left( r_t(\theta) \, \hat{A}_t, \; \text{clip}(r_t(\theta), 1-\epsilon, 1+\epsilon) \, \hat{A}_t \right) \right]
$$

where $\hat{A}_t$ is the advantage estimate and $\epsilon$ (typically $0.1$–$0.2$) controls the trust region. The $\min$ ensures the objective is pessimistic — it only lets the ratio improve the objective up to the clipping boundary.

**In RLHF:** PPO is applied with a reward model score as the reward and a KL penalty to $\pi_{\text{ref}}$. Requires maintaining four models in memory (policy, reference, reward, value), making it expensive.

## DPO (Direct Preference Optimization)

DPO eliminates the reward model entirely. It shows that the optimal policy under the KL-constrained reward objective satisfies:

$$
r(x, y) = \beta \log \frac{\pi^*(y|x)}{\pi_{\text{ref}}(y|x)} + \beta \log Z(x)
$$

Substituting this into the Bradley-Terry preference model and canceling $Z(x)$ gives the DPO loss:

$$
\mathcal{L}_{\text{DPO}} = -\mathbb{E}_{(x, y_w, y_l)} \left[ \log \sigma\!\left( \beta \log \frac{\pi_\theta(y_w|x)}{\pi_{\text{ref}}(y_w|x)} - \beta \log \frac{\pi_\theta(y_l|x)}{\pi_{\text{ref}}(y_l|x)} \right) \right]
$$

where $y_w$ is the preferred response, $y_l$ is the rejected response, and $\sigma$ is the sigmoid function.

**Key insight:** DPO reparameterizes the reward as the log-ratio between policy and reference, turning RL into a supervised classification problem on preference pairs. No reward model, no value function, no sampling during training.

## GRPO (Group Relative Policy Optimization)

GRPO (DeepSeek-R1) removes the value network from PPO by estimating advantages from a **group of sampled outputs**. For a prompt $x$, sample $G$ responses $\{y_1, \dots, y_G\}$ from $\pi_{\theta_{\text{old}}}$ and compute rewards $\{r_1, \dots, r_G\}$. The advantage for each response is the normalized reward within the group:

$$
\hat{A}_i = \frac{r_i - \text{mean}(\{r_1, \dots, r_G\})}{\text{std}(\{r_1, \dots, r_G\})}
$$

The objective uses PPO-style clipping at the **token level**:

$$
\mathcal{L}_{\text{GRPO}} = \mathbb{E} \left[ \frac{1}{G} \sum_{i=1}^{G} \frac{1}{|y_i|} \sum_{t=1}^{|y_i|} \min\!\left( r_{i,t}(\theta)\, \hat{A}_i, \; \text{clip}(r_{i,t}(\theta), 1-\epsilon, 1+\epsilon)\, \hat{A}_i \right) \right] - \beta \, D_{\text{KL}}(\pi_\theta \| \pi_{\text{ref}})
$$

where $r_{i,t}(\theta) = \frac{\pi_\theta(y_{i,t} | x, y_{i,<t})}{\pi_{\theta_{\text{old}}}(y_{i,t} | x, y_{i,<t})}$.

**Key insight:** by comparing outputs within a group, GRPO gets a relative ranking signal without training a separate value function, reducing memory from 4 models to 2 (policy + reference).

## Reinforce Leave-One-Out (RLOO)

RLOO is a variance reduction technique for Reinforce. Sample $K$ responses per prompt and use the average reward of the *other* $K-1$ responses as the baseline for each:

$$
b_i = \frac{1}{K-1} \sum_{j \neq i} r_j
$$

$$
\nabla_\theta J = \frac{1}{K} \sum_{i=1}^{K} \nabla_\theta \log \pi_\theta(y_i|x) \cdot (r_i - b_i)
$$

This gives an unbiased, lower-variance gradient without a learned value function. Conceptually similar to GRPO but uses a leave-one-out baseline instead of group normalization.

## Comparison

| Algorithm | Reward model | Value network | On/off-policy | Key idea |
|---|---|---|---|---|
| Standard RL | Yes | No | On | Vanilla policy gradient |
| PPO | Yes | Yes | On | Clipped surrogate objective |
| DPO | No | No | Off | Reward is log policy ratio |
| GRPO | Yes | No | On | Group-normalized advantages |
| RLOO | Yes | No | On | Leave-one-out baseline |

## Notation Summary

| Symbol | Meaning |
|---|---|
| $\pi_\theta$ | Current policy (the model being trained) |
| $\pi_{\text{ref}}$ | Reference policy (frozen SFT model) |
| $r_\phi(x, y)$ | Reward model score |
| $\beta$ | KL penalty coefficient |
| $\hat{A}_t$ | Advantage estimate |
| $\epsilon$ | PPO clipping parameter |
| $y_w, y_l$ | Preferred and rejected responses |
| $\sigma$ | Sigmoid function |
| $G, K$ | Number of sampled responses per prompt |
