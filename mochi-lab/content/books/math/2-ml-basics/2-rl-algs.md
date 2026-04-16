---
sidebar_position: 2
---

# RL Algorithms for LLMs

## Background

Reinforcement learning from human feedback (RLHF) fine-tunes a pretrained language model $\pi_\theta$ to align with human preferences, using a reward signal derived from human judgments [@ouyang2022training]. The standard pipeline has three stages:

1. **Supervised fine-tuning (SFT):** Train on high-quality demonstration data to obtain a reference policy $\pi_{\text{ref}}$.
2. **Reward modeling:** Train a scalar reward model $r_\phi(x, y)$ on human preference pairs $(y_w \succ y_l | x)$ using the Bradley--Terry model.
3. **RL optimization:** Maximize the expected reward while constraining the policy to stay close to $\pi_{\text{ref}}$.

The general objective is:

<Equation id="eq-rlhf-objective">

$$\max_{\theta} \; \mathbb{E}_{x \sim \mathcal{D},\, y \sim \pi_\theta(\cdot|x)} \left[ r_\phi(x, y) \right] - \beta \, D_{\text{KL}}\!\left(\pi_\theta(\cdot|x) \,\|\, \pi_{\text{ref}}(\cdot|x)\right)$$

</Equation>

<Remark id="rmk-kl-penalty-purpose">
The KL penalty serves two purposes: (1) it prevents **reward hacking** -- the policy finding degenerate outputs that score high on the (imperfect) reward model but are actually low-quality; (2) it prevents **catastrophic forgetting** of capabilities learned during pretraining. The coefficient $\beta$ controls this tradeoff: larger $\beta$ keeps the policy closer to $\pi_{\text{ref}}$ at the cost of lower reward.
</Remark>

<Definition id="def-bradley-terry" name="Bradley--Terry Preference Model">
The **Bradley--Terry model** assigns a probability that response $y_w$ is preferred over $y_l$ given prompt $x$:

<Equation id="eq-bradley-terry">

$$P(y_w \succ y_l | x) = \sigma\!\left(r_\phi(x, y_w) - r_\phi(x, y_l)\right) = \frac{1}{1 + \exp\!\left(-(r_\phi(x, y_w) - r_\phi(x, y_l))\right)}$$

</Equation>

The reward model is trained by maximizing the log-likelihood of observed preferences:

$$\mathcal{L}_{\text{RM}} = -\mathbb{E}_{(x, y_w, y_l)}\!\left[\log \sigma\!\left(r_\phi(x, y_w) - r_\phi(x, y_l)\right)\right]$$

</Definition>

## REINFORCE: The Foundation

<Definition id="def-reinforce" name="REINFORCE (Policy Gradient)">
The simplest policy gradient method. By the **log-derivative trick** (also called the REINFORCE trick or score function estimator), the gradient of the expected reward is:

<Equation id="eq-policy-gradient">

$$\nabla_\theta J(\theta) = \mathbb{E}_{y \sim \pi_\theta(\cdot|x)} \left[ \nabla_\theta \log \pi_\theta(y|x) \cdot R(x, y) \right]$$

</Equation>

</Definition>

**Derivation.** We want $\nabla_\theta \mathbb{E}_{y \sim \pi_\theta}[R(y)]$. Since $\nabla_\theta \pi_\theta(y|x) = \pi_\theta(y|x) \nabla_\theta \log \pi_\theta(y|x)$:

$$\nabla_\theta \mathbb{E}[R] = \nabla_\theta \sum_y \pi_\theta(y|x) R(y) = \sum_y \pi_\theta(y|x) \nabla_\theta \log \pi_\theta(y|x) \cdot R(y) = \mathbb{E}_{\pi_\theta}\!\left[\nabla_\theta \log \pi_\theta(y|x) \cdot R(y)\right]$$

A **baseline** $b(x)$ reduces variance without introducing bias (since $\mathbb{E}[\nabla_\theta \log \pi_\theta \cdot b] = 0$):

<Equation id="eq-reinforce-baseline">

$$\nabla_\theta J = \mathbb{E}_{\pi_\theta} \left[ \nabla_\theta \log \pi_\theta(y|x) \cdot (R(x,y) - b(x)) \right]$$

</Equation>

**Limitations:** High variance (requires many samples per update), on-policy only (samples must be discarded after each parameter update), no trust region (large updates can destabilize training).

## PPO (Proximal Policy Optimization)

<Definition id="def-ppo" name="PPO">
PPO constrains how much the policy can change per update using a clipped surrogate objective [@schulman2017ppo]. Define the probability ratio between the current and old policy:

$$r_t(\theta) = \frac{\pi_\theta(a_t | s_t)}{\pi_{\theta_{\text{old}}}(a_t | s_t)}$$

The clipped objective is:

<Equation id="eq-ppo-clip">

$$\mathcal{L}^{\text{CLIP}}(\theta) = \mathbb{E}_t \left[ \min\!\left( r_t(\theta) \, \hat{A}_t, \; \text{clip}(r_t(\theta), 1-\epsilon, 1+\epsilon) \, \hat{A}_t \right) \right]$$

</Equation>

where $\hat{A}_t$ is the advantage estimate (typically computed via GAE -- Generalized Advantage Estimation) and $\epsilon$ (typically $0.1$--$0.2$) defines the trust region.
</Definition>

<Remark id="rmk-ppo-clip-intuition">
**Why the min and clip?** The $\min$ makes the objective pessimistic:

- If the advantage $\hat{A}_t > 0$ (action was good): increasing $r_t$ beyond $1 + \epsilon$ gets clipped, preventing overly aggressive exploitation.
- If $\hat{A}_t < 0$ (action was bad): decreasing $r_t$ below $1 - \epsilon$ gets clipped, preventing the policy from moving too far in a single step.

This achieves a similar effect to TRPO's hard KL constraint but is much simpler to implement and computationally cheaper.
</Remark>

<Definition id="def-gae" name="Generalized Advantage Estimation">
GAE computes the advantage by exponentially weighting $n$-step temporal difference estimates [@schulman2016gae]:

<Equation id="eq-gae">

$$\hat{A}_t^{\text{GAE}(\gamma, \lambda)} = \sum_{l=0}^{\infty} (\gamma \lambda)^l \delta_{t+l}, \quad \text{where } \delta_t = r_t + \gamma V(s_{t+1}) - V(s_t)$$

</Equation>

$\lambda = 0$ gives the one-step TD advantage (low variance, high bias); $\lambda = 1$ gives the Monte Carlo advantage (high variance, low bias).
</Definition>

<Remark id="rmk-ppo-cost">
**In RLHF:** PPO requires maintaining four models in memory simultaneously:
1. **Policy** $\pi_\theta$ -- the model being trained
2. **Reference** $\pi_{\text{ref}}$ -- frozen SFT model for KL computation
3. **Reward model** $r_\phi$ -- evaluates response quality
4. **Value function** $V_\psi$ -- estimates expected return for advantage computation

For a 7B parameter model, this means ~28B parameters in memory, requiring at least 4 GPUs with 80GB each just for model weights in FP16. This memory overhead motivates methods like DPO, GRPO, and RLOO that eliminate one or more of these components.
</Remark>

## DPO (Direct Preference Optimization)

<Definition id="def-dpo" name="DPO">
DPO eliminates the reward model entirely by deriving a closed-form relationship between the optimal policy and the reward [@rafailov2023dpo].
</Definition>

**Derivation.** The KL-constrained reward maximization objective has a closed-form optimal policy:

$$\pi^*(y|x) = \frac{1}{Z(x)} \pi_{\text{ref}}(y|x) \exp\!\left(\frac{1}{\beta} r(x, y)\right)$$

where $Z(x) = \sum_y \pi_{\text{ref}}(y|x) \exp(r(x,y)/\beta)$ is the partition function. Solving for the reward:

<Equation id="eq-dpo-reward-reparameterization">

$$r(x, y) = \beta \log \frac{\pi^*(y|x)}{\pi_{\text{ref}}(y|x)} + \beta \log Z(x)$$

</Equation>

Substituting this into the Bradley--Terry preference model $P(y_w \succ y_l) = \sigma(r(x,y_w) - r(x,y_l))$ and noting that $Z(x)$ cancels:

<Equation id="eq-dpo-loss">

$$\mathcal{L}_{\text{DPO}}(\theta) = -\mathbb{E}_{(x, y_w, y_l)} \left[ \log \sigma\!\left( \beta \log \frac{\pi_\theta(y_w|x)}{\pi_{\text{ref}}(y_w|x)} - \beta \log \frac{\pi_\theta(y_l|x)}{\pi_{\text{ref}}(y_l|x)} \right) \right]$$

</Equation>

<Remark id="rmk-dpo-insight">
DPO reparameterizes the reward as the log-ratio between policy and reference, turning RL into a supervised classification problem on preference pairs. Key advantages:
- **No reward model** -- eliminates $r_\phi$ from memory
- **No value function** -- eliminates $V_\psi$ from memory
- **No sampling during training** -- uses pre-collected preference data (off-policy)
- **Simpler implementation** -- just a modified cross-entropy loss

Key limitation: because it is off-policy, DPO can suffer from distributional shift if the preference data was collected under a very different policy than $\pi_\theta$.
</Remark>

<Remark id="rmk-dpo-gradient">
**DPO gradient analysis.** The gradient of $\mathcal{L}_{\text{DPO}}$ has an intuitive form:

$$\nabla_\theta \mathcal{L}_{\text{DPO}} \propto -\underbrace{\sigma\!\left(\hat{r}_l - \hat{r}_w\right)}_{\text{weighting}} \left[\beta \nabla_\theta \log \pi_\theta(y_w|x) - \beta \nabla_\theta \log \pi_\theta(y_l|x)\right]$$

where $\hat{r}_i = \beta \log \frac{\pi_\theta(y_i|x)}{\pi_{\text{ref}}(y_i|x)}$ is the implicit reward. The weighting term is large when the model incorrectly ranks the pair (assigns higher implicit reward to $y_l$ than $y_w$), focusing learning on mistakes.
</Remark>

## GRPO (Group Relative Policy Optimization)

<Definition id="def-grpo" name="GRPO">
GRPO [@shao2024deepseekmath] removes the value network from PPO by estimating advantages from a **group of sampled outputs**. For a prompt $x$, sample $G$ responses $\{y_1, \dots, y_G\}$ from $\pi_{\theta_{\text{old}}}$ and compute rewards $\{r_1, \dots, r_G\}$. The advantage for each response is the group-normalized reward:

<Equation id="eq-grpo-advantage">

$$\hat{A}_i = \frac{r_i - \text{mean}(\{r_1, \dots, r_G\})}{\text{std}(\{r_1, \dots, r_G\}) + \epsilon}$$

</Equation>

</Definition>

The objective uses PPO-style clipping at the **token level**, averaging over all tokens in each response:

<Equation id="eq-grpo-loss">

$$\mathcal{L}_{\text{GRPO}}(\theta) = \mathbb{E}_{x} \left[ \frac{1}{G} \sum_{i=1}^{G} \frac{1}{|y_i|} \sum_{t=1}^{|y_i|} \min\!\left( r_{i,t}(\theta)\, \hat{A}_i, \; \text{clip}(r_{i,t}(\theta), 1-\epsilon, 1+\epsilon)\, \hat{A}_i \right) \right] - \beta \, D_{\text{KL}}(\pi_\theta \| \pi_{\text{ref}})$$

</Equation>

where $r_{i,t}(\theta) = \frac{\pi_\theta(y_{i,t} | x, y_{i,<t})}{\pi_{\theta_{\text{old}}}(y_{i,t} | x, y_{i,<t})}$ is the per-token probability ratio.

<Remark id="rmk-grpo-insight">
**Why group normalization works.** By comparing outputs within a group from the same prompt, GRPO obtains a relative ranking signal without a learned value function. The group mean acts as a prompt-specific baseline, and the standard deviation normalizes for reward scale. This reduces memory from 4 models (PPO) to 2 (policy + reference), at the cost of requiring $G$ forward passes per prompt. GRPO was used to train DeepSeek-Math and DeepSeek-R1 [@shao2024deepseekmath; @deepseekai2025r1].
</Remark>

<Remark id="rmk-grpo-kl">
GRPO typically computes the KL penalty at the token level using an approximation:

$$D_{\text{KL}}(\pi_\theta \| \pi_{\text{ref}}) \approx \frac{1}{|y|} \sum_{t=1}^{|y|} \left[\frac{\pi_\theta(y_t | x, y_{<t})}{\pi_{\text{ref}}(y_t | x, y_{<t})} - \log \frac{\pi_\theta(y_t | x, y_{<t})}{\pi_{\text{ref}}(y_t | x, y_{<t})} - 1\right]$$

This uses the identity $D_{\text{KL}}(p \| q) = \mathbb{E}_p[p/q - \log(p/q) - 1]$ for a non-negative, unbiased KL estimate.
</Remark>

## RLOO (REINFORCE Leave-One-Out)

<Definition id="def-rloo" name="RLOO">
RLOO is a variance reduction technique for REINFORCE that uses a leave-one-out baseline [@ahmadian2024rloo]. Sample $K$ responses per prompt and use the average reward of the *other* $K-1$ responses as the baseline for each:

<Equation id="eq-rloo-baseline">

$$b_i = \frac{1}{K-1} \sum_{j \neq i} r_j$$

</Equation>

<Equation id="eq-rloo-gradient">

$$\nabla_\theta J = \frac{1}{K} \sum_{i=1}^{K} \nabla_\theta \log \pi_\theta(y_i|x) \cdot (r_i - b_i)$$

</Equation>

</Definition>

<Remark id="rmk-rloo-properties">
RLOO has several desirable properties:

1. **Unbiased:** Each leave-one-out baseline $b_i$ is independent of $y_i$, so the gradient estimator is unbiased.
2. **Lower variance than REINFORCE:** The per-sample baseline captures the difficulty of the prompt, reducing variance from prompt-to-prompt reward differences.
3. **No learned value function:** Like GRPO, avoids the memory cost of a separate value network.
4. **Simple implementation:** Compared to GRPO, RLOO does not clip probability ratios or normalize by standard deviation -- it is closer to vanilla REINFORCE with a smart baseline.
</Remark>

## Comparison

<Table id="tab-rl-comparison" caption="Comparison of RL algorithms for LLM alignment.">

| Algorithm | Reward Model | Value Network | On/Off-Policy | Models in Memory | Key Idea |
|---|---|---|---|---|---|
| REINFORCE | Yes | No | On | 2 | Vanilla policy gradient + baseline |
| PPO | Yes | Yes | On | 4 | Clipped surrogate with trust region |
| DPO | No | No | Off | 2 | Reward = log policy ratio; supervised loss |
| GRPO | Yes | No | On | 2 | Group-normalized advantages with clipping |
| RLOO | Yes | No | On | 2 | Leave-one-out baseline for variance reduction |

</Table>

<Remark id="rmk-rl-trends">
**Current trends (as of 2025):**
- **Outcome-based RL** (using verifiable rewards like code execution, math proof checking) is replacing learned reward models for domains where automated verification is possible [@deepseekai2025r1].
- **GRPO** has become the dominant algorithm for math and code reasoning, where sampling $G$ solutions and checking correctness provides a natural reward signal.
- **DPO** remains popular for general-purpose alignment where preference data is readily available and the simplicity of offline training is valued.
- **Online DPO variants** (like OAIF [@guo2024direct]) combine DPO's simplicity with online data collection to mitigate distributional shift.
</Remark>

## Notation Summary

<Table id="tab-notation-rl" caption="Notation used in this chapter.">

| Symbol | Meaning |
|---|---|
| $\pi_\theta$ | Current policy (the model being trained) |
| $\pi_{\text{ref}}$ | Reference policy (frozen SFT model) |
| $\pi^*$ | Optimal policy under KL-constrained objective |
| $r_\phi(x, y)$ | Reward model score |
| $\beta$ | KL penalty coefficient |
| $\hat{A}_t$ | Advantage estimate |
| $\epsilon$ | PPO/GRPO clipping parameter |
| $\gamma, \lambda$ | GAE discount and decay factors |
| $y_w, y_l$ | Preferred and rejected responses |
| $\sigma(\cdot)$ | Sigmoid function |
| $G, K$ | Number of sampled responses per prompt |
| $Z(x)$ | Partition function |

</Table>
