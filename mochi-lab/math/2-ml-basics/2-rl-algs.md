---
sidebar_position: 2
---

# RL Algorithms for LLMs

## Background

Reinforcement learning from human feedback (RLHF) fine-tunes a pretrained language model $\pi_\theta$ using a reward signal [@ouyang2022training]. The standard pipeline is:

1. **SFT** -- supervised fine-tuning on demonstration data to get $\pi_{\text{ref}}$.
2. **Reward model** -- train $r_\phi(x, y)$ on human preference pairs.
3. **RL optimization** -- maximize reward while staying close to $\pi_{\text{ref}}$.

The general objective is:

<Equation id="eq-rlhf-objective">

$$\max_{\theta} \; \mathbb{E}_{x \sim \mathcal{D},\, y \sim \pi_\theta(\cdot|x)} \left[ r_\phi(x, y) \right] - \beta \, D_{\text{KL}}\!\left(\pi_\theta \| \pi_{\text{ref}}\right)$$

</Equation>

The KL penalty prevents the policy from drifting too far from the reference and exploiting reward model errors.

## Standard RL

The simplest policy gradient method. The gradient of the expected reward is:

<Equation id="eq-policy-gradient">

$$\nabla_\theta J = \mathbb{E}_{\pi_\theta} \left[ \nabla_\theta \log \pi_\theta(y|x) \cdot R \right]$$

</Equation>

where $R$ is the return. A **baseline** $b$ (e.g. average reward) reduces variance without introducing bias:

$$
\nabla_\theta J = \mathbb{E}_{\pi_\theta} \left[ \nabla_\theta \log \pi_\theta(y|x) \cdot (R - b) \right]
$$

**Limitation:** high variance, on-policy only (must discard samples after each update).

## PPO (Proximal Policy Optimization)

PPO constrains how much the policy can change per update using a clipped surrogate objective [@schulman2017ppo]. Define the probability ratio:

$$
r_t(\theta) = \frac{\pi_\theta(a_t | s_t)}{\pi_{\theta_{\text{old}}}(a_t | s_t)}
$$

The clipped objective is:

<Equation id="eq-ppo-clip">

$$\mathcal{L}^{\text{CLIP}} = \mathbb{E}_t \left[ \min\!\left( r_t(\theta) \, \hat{A}_t, \; \text{clip}(r_t(\theta), 1-\epsilon, 1+\epsilon) \, \hat{A}_t \right) \right]$$

</Equation>

where $\hat{A}_t$ is the advantage estimate and $\epsilon$ (typically $0.1$--$0.2$) controls the trust region. The $\min$ ensures the objective is pessimistic -- it only lets the ratio improve the objective up to the clipping boundary.

<Remark id="rmk-ppo-cost">
**In RLHF:** PPO is applied with a reward model score as the reward and a KL penalty to $\pi_{\text{ref}}$. Requires maintaining four models in memory (policy, reference, reward, value), making it expensive.
</Remark>

## DPO (Direct Preference Optimization)

DPO eliminates the reward model entirely [@rafailov2023dpo]. It shows that the optimal policy under the KL-constrained reward objective satisfies:

$$
r(x, y) = \beta \log \frac{\pi^*(y|x)}{\pi_{\text{ref}}(y|x)} + \beta \log Z(x)
$$

Substituting this into the Bradley-Terry preference model and canceling $Z(x)$ gives the DPO loss:

<Equation id="eq-dpo-loss">

$$\mathcal{L}_{\text{DPO}} = -\mathbb{E}_{(x, y_w, y_l)} \left[ \log \sigma\!\left( \beta \log \frac{\pi_\theta(y_w|x)}{\pi_{\text{ref}}(y_w|x)} - \beta \log \frac{\pi_\theta(y_l|x)}{\pi_{\text{ref}}(y_l|x)} \right) \right]$$

</Equation>

where $y_w$ is the preferred response, $y_l$ is the rejected response, and $\sigma$ is the sigmoid function.

<Remark id="rmk-dpo-insight">
DPO reparameterizes the reward as the log-ratio between policy and reference, turning RL into a supervised classification problem on preference pairs. No reward model, no value function, no sampling during training.
</Remark>

## GRPO (Group Relative Policy Optimization)

GRPO [@shao2024deepseekmath] removes the value network from PPO by estimating advantages from a **group of sampled outputs**. For a prompt $x$, sample $G$ responses $\{y_1, \dots, y_G\}$ from $\pi_{\theta_{\text{old}}}$ and compute rewards $\{r_1, \dots, r_G\}$. The advantage for each response is the normalized reward within the group:

<Equation id="eq-grpo-advantage">

$$\hat{A}_i = \frac{r_i - \text{mean}(\{r_1, \dots, r_G\})}{\text{std}(\{r_1, \dots, r_G\})}$$

</Equation>

The objective uses PPO-style clipping at the **token level**:

<Equation id="eq-grpo-loss">

$$\mathcal{L}_{\text{GRPO}} = \mathbb{E} \left[ \frac{1}{G} \sum_{i=1}^{G} \frac{1}{|y_i|} \sum_{t=1}^{|y_i|} \min\!\left( r_{i,t}(\theta)\, \hat{A}_i, \; \text{clip}(r_{i,t}(\theta), 1-\epsilon, 1+\epsilon)\, \hat{A}_i \right) \right] - \beta \, D_{\text{KL}}(\pi_\theta \| \pi_{\text{ref}})$$

</Equation>

where $r_{i,t}(\theta) = \frac{\pi_\theta(y_{i,t} | x, y_{i,<t})}{\pi_{\theta_{\text{old}}}(y_{i,t} | x, y_{i,<t})}$.

<Remark id="rmk-grpo-insight">
By comparing outputs within a group, GRPO gets a relative ranking signal without training a separate value function, reducing memory from 4 models to 2 (policy + reference).
</Remark>

## Reinforce Leave-One-Out (RLOO)

RLOO is a variance reduction technique for Reinforce [@ahmadian2024rloo]. Sample $K$ responses per prompt and use the average reward of the *other* $K-1$ responses as the baseline for each:

<Equation id="eq-rloo-baseline">

$$b_i = \frac{1}{K-1} \sum_{j \neq i} r_j$$

</Equation>

<Equation id="eq-rloo-gradient">

$$\nabla_\theta J = \frac{1}{K} \sum_{i=1}^{K} \nabla_\theta \log \pi_\theta(y_i|x) \cdot (r_i - b_i)$$

</Equation>

This gives an unbiased, lower-variance gradient without a learned value function. Conceptually similar to GRPO but uses a leave-one-out baseline instead of group normalization.

## Comparison

<Table id="tab-rl-comparison" caption="Comparison of RL algorithms for LLM alignment.">

| Algorithm | Reward model | Value network | On/off-policy | Key idea |
|---|---|---|---|---|
| Standard RL | Yes | No | On | Vanilla policy gradient |
| PPO | Yes | Yes | On | Clipped surrogate objective |
| DPO | No | No | Off | Reward is log policy ratio |
| GRPO | Yes | No | On | Group-normalized advantages |
| RLOO | Yes | No | On | Leave-one-out baseline |

</Table>

## Notation Summary

<Table id="tab-notation-rl" caption="Notation used in RL algorithms for LLMs.">

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

</Table>
