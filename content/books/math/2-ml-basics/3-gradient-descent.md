---
sidebar_position: 3
---

# Gradient Descent

## The Optimization Problem

Machine learning reduces to **empirical risk minimization** (ERM): finding parameters $\theta$ that minimize a loss function averaged over a training dataset $\mathcal{D} = \{(x_i, y_i)\}_{i=1}^N$:

<Equation id="eq-erm">

$$\theta^* = \arg\min_\theta \; \mathcal{L}(\theta) = \arg\min_\theta \; \frac{1}{N} \sum_{i=1}^{N} \ell(f_\theta(x_i), y_i)$$

</Equation>

For most models of interest (neural networks), $\mathcal{L}(\theta)$ is non-convex and high-dimensional (billions of parameters), ruling out closed-form solutions. Gradient descent solves this iteratively by moving in the direction of steepest descent.

## Vanilla Gradient Descent

<Definition id="def-gd" name="Gradient Descent">
Starting from an initial $\theta_0$, the update rule computes the gradient over the full dataset and takes a step in the negative gradient direction:

<Equation id="eq-gd-update">

$$\theta_{t+1} = \theta_t - \eta \nabla_\theta \mathcal{L}(\theta_t) = \theta_t - \frac{\eta}{N} \sum_{i=1}^{N} \nabla_\theta \ell(f_{\theta_t}(x_i), y_i)$$

</Equation>

where $\eta > 0$ is the **learning rate** (step size).
</Definition>

<Remark id="rmk-gd-geometric">
**Geometric interpretation.** At each point $\theta_t$, the gradient $\nabla \mathcal{L}(\theta_t)$ is a vector pointing in the direction of steepest *increase* of $\mathcal{L}$. Moving in the direction $-\nabla \mathcal{L}$ is the locally optimal descent direction. However, "locally optimal" can be misleading: the gradient only gives a good direction for infinitesimally small steps. For finite step sizes, the curvature of $\mathcal{L}$ matters.
</Remark>

:::info[Interactive: Gradient Descent]
Drag the blue point to set a starting position on the curve, adjust the learning rate $\eta$, and click **Run GD** to watch gradient descent converge. The dashed orange line shows the tangent (gradient direction) at the starting point. Try a large learning rate to see oscillation or divergence.
:::

<GradientDescentDemo />

### Convergence Analysis

<Definition id="def-lipschitz-gradient" name="L-Smoothness">
A differentiable function $\mathcal{L}$ has **$L$-Lipschitz continuous gradients** (is $L$-smooth) if:

$$\|\nabla \mathcal{L}(\theta) - \nabla \mathcal{L}(\theta')\| \leq L \|\theta - \theta'\| \quad \forall \, \theta, \theta'$$

Equivalently, the loss is bounded by a quadratic around any point:

$$\mathcal{L}(\theta') \leq \mathcal{L}(\theta) + \nabla \mathcal{L}(\theta)^\top (\theta' - \theta) + \frac{L}{2}\|\theta' - \theta\|^2$$

The constant $L$ is the largest eigenvalue of the Hessian $\nabla^2 \mathcal{L}$.
</Definition>

<Theorem id="thm-gd-convergence-convex" name="GD Convergence (Convex)">
For an $L$-smooth convex function, gradient descent with step size $\eta = 1/L$ satisfies:

<Equation id="eq-gd-convergence-convex">

$$\mathcal{L}(\theta_T) - \mathcal{L}(\theta^*) \leq \frac{L \|\theta_0 - \theta^*\|^2}{2T}$$

</Equation>

This is an $O(1/T)$ rate: to achieve $\epsilon$-accuracy, we need $T = O(L \|\theta_0 - \theta^*\|^2 / \epsilon)$ iterations.
</Theorem>

<Theorem id="thm-gd-convergence-strong" name="GD Convergence (Strongly Convex)">
If $\mathcal{L}$ is additionally **$\mu$-strongly convex** ($\nabla^2 \mathcal{L} \succeq \mu I$), gradient descent with $\eta = 1/L$ converges linearly:

<Equation id="eq-gd-convergence-strong">

$$\mathcal{L}(\theta_T) - \mathcal{L}(\theta^*) \leq \left(1 - \frac{\mu}{L}\right)^T \left(\mathcal{L}(\theta_0) - \mathcal{L}(\theta^*)\right)$$

</Equation>

The **condition number** $\kappa = L/\mu$ determines convergence speed. Poorly conditioned problems ($\kappa \gg 1$) converge slowly because the loss surface is elongated: the gradient oscillates across the narrow direction while making slow progress along the wide direction.
</Theorem>

## Stochastic Gradient Descent (SGD)

<Definition id="def-sgd" name="Stochastic Gradient Descent">
SGD approximates the full gradient with a mini-batch $\mathcal{B} \subset \mathcal{D}$ of size $B = |\mathcal{B}|$, sampled uniformly:

<Equation id="eq-sgd-update">

$$\theta_{t+1} = \theta_t - \eta_t \cdot g_t, \quad g_t = \frac{1}{B} \sum_{i \in \mathcal{B}_t} \nabla_\theta \ell(f_{\theta_t}(x_i), y_i)$$

</Equation>
</Definition>

**Properties of the stochastic gradient $g_t$:**

1. **Unbiased:** $\mathbb{E}_{\mathcal{B}}[g_t] = \nabla \mathcal{L}(\theta_t)$
2. **Bounded variance:** $\mathbb{E}\|g_t - \nabla \mathcal{L}(\theta_t)\|^2 \leq \sigma^2 / B$, where $\sigma^2$ is the per-sample gradient variance
3. **Computational cost:** $O(B)$ per step instead of $O(N)$

<Theorem id="thm-sgd-convergence" name="SGD Convergence (Non-Convex)">
For an $L$-smooth function with stochastic gradients having variance bounded by $\sigma^2$, SGD with step size $\eta = c / \sqrt{T}$ satisfies:

<Equation id="eq-sgd-convergence">

$$\frac{1}{T}\sum_{t=0}^{T-1} \mathbb{E}\|\nabla \mathcal{L}(\theta_t)\|^2 \leq O\!\left(\frac{\sigma}{\sqrt{T}} + \frac{1}{T}\right)$$

</Equation>

This is an $O(1/\sqrt{T})$ rate to a stationary point (where $\nabla \mathcal{L} \approx 0$). Note: for non-convex functions, a stationary point may be a saddle point or local minimum, not necessarily a global minimum.
</Theorem>

<Example id="ex-gd-conditioning">
**Gradient descent on an ill-conditioned quadratic.** Consider the 2D loss $\mathcal{L}(\theta) = \tfrac{1}{2}\left(10\,\theta_1^2 + \theta_2^2\right)$, whose gradient is $\nabla \mathcal{L}(\theta) = (10\,\theta_1, \; \theta_2)$. The Hessian is diagonal with eigenvalues $L = 10$ and $\mu = 1$, so the condition number is $\kappa = L/\mu = 10$. The minimum is at the origin.

Run full-batch GD with $\eta = 0.18$ from $\theta_0 = (1, 1)$. Because the loss is separable, each coordinate updates independently by the scalar rule $\theta_{t+1} = (1 - \eta\,h)\,\theta_t$, where $h$ is that coordinate's curvature:

- **Steep direction** ($h = 10$): the multiplier is $1 - 0.18 \cdot 10 = -0.8$, so $\theta_{1}$ follows $1 \to -0.8 \to 0.64 \to -0.512$. The sign flips every step: this is the oscillation across the narrow axis, shrinking only by a factor of $0.8$ per step.
- **Shallow direction** ($h = 1$): the multiplier is $1 - 0.18 \cdot 1 = 0.82$, so $\theta_{2}$ follows $1 \to 0.82 \to 0.672 \to 0.551$, decreasing monotonically but slowly.

The first two iterates are therefore $\theta_1 = (-0.8, 0.82)$ and $\theta_2 = (0.64, 0.672)$. The step size is constrained by the steep direction (any $\eta > 2/L = 0.2$ diverges there), yet the shallow direction barely moves with that same $\eta$. This tension is exactly what the condition number $\kappa$ measures, and it is the gap that momentum and adaptive methods are designed to close.
</Example>

<Remark id="rmk-sgd-noise">
**SGD noise as implicit regularization.** The stochastic noise in mini-batch gradients serves as implicit regularization. Empirical and theoretical evidence suggests:

1. SGD noise helps escape sharp minima (high curvature) in favor of flat minima (low curvature), which tend to generalize better [@keskar2017large].
2. The noise scale is proportional to $\eta / B$ (learning rate divided by batch size), which is why the **linear scaling rule** [@goyal2017accurate] prescribes scaling $\eta$ proportionally to $B$.
3. Large-batch training (small noise) can converge to sharp minima that generalize poorly, unless carefully tuned with warmup and learning rate schedules.
</Remark>

## Momentum

SGD oscillates in directions with high curvature (large eigenvalues of the Hessian) while making slow progress along directions with low curvature. **Momentum** fixes this by accumulating a velocity vector:

<Definition id="def-momentum" name="SGD with Momentum">

<Equation id="eq-momentum">

$$v_{t+1} = \mu \, v_t + g_t, \qquad \theta_{t+1} = \theta_t - \eta \, v_{t+1}$$

</Equation>

where $\mu \in [0, 1)$ is the momentum coefficient (typically $\mu = 0.9$). The velocity $v_t$ is an exponential moving average of past gradients with effective window size $\sim 1/(1-\mu)$.
</Definition>

<Remark id="rmk-momentum-intuition">
**Physical analogy.** Think of a ball rolling down the loss surface. Without momentum, the ball stops immediately when the slope changes direction (oscillation). With momentum, the ball has inertia: it accelerates along consistent downhill directions and dampens oscillations. On a quadratic with condition number $\kappa$, optimal momentum $\mu^* = (\sqrt{\kappa} - 1)/(\sqrt{\kappa} + 1)$ improves convergence from $O(\kappa \log 1/\epsilon)$ to $O(\sqrt{\kappa} \log 1/\epsilon)$ iterations.
</Remark>

**Nesterov accelerated gradient** evaluates the gradient at the "look-ahead" position $\theta_t - \eta \mu v_t$:

<Equation id="eq-nesterov">

$$v_{t+1} = \mu \, v_t + \nabla \mathcal{L}(\theta_t - \eta \mu v_t), \qquad \theta_{t+1} = \theta_t - \eta \, v_{t+1}$$

</Equation>

Nesterov momentum achieves the optimal $O(1/T^2)$ convergence rate for smooth convex functions, compared to $O(1/T)$ for vanilla GD [@nesterov1983method]. In practice, the improvement over classical momentum is often modest for deep learning.

## Adam (Adaptive Moment Estimation)

<Definition id="def-adam" name="Adam">
**Adam** [@kingma2015adam] combines momentum with per-parameter adaptive learning rates by tracking exponential moving averages of the first and second moments of the gradient:

<Equation id="eq-adam-moments">

$$m_t = \beta_1 m_{t-1} + (1 - \beta_1) g_t \qquad \text{(first moment / mean)}$$

</Equation>

<Equation id="eq-adam-second-moment">

$$v_t = \beta_2 v_{t-1} + (1 - \beta_2) g_t^2 \qquad \text{(second moment / uncentered variance)}$$

</Equation>

Bias-corrected estimates (since $m_0 = v_0 = 0$):

<Equation id="eq-adam-correction">

$$\hat{m}_t = \frac{m_t}{1 - \beta_1^t}, \qquad \hat{v}_t = \frac{v_t}{1 - \beta_2^t}$$

</Equation>

Parameter update:

<Equation id="eq-adam-update">

$$\theta_{t+1} = \theta_t - \eta \frac{\hat{m}_t}{\sqrt{\hat{v}_t} + \epsilon}$$

</Equation>

Default hyperparameters: $\beta_1 = 0.9$, $\beta_2 = 0.999$, $\epsilon = 10^{-8}$.
</Definition>

<Remark id="rmk-adam-insight">
**Why Adam works.** The effective learning rate for parameter $\theta_i$ at step $t$ is $\eta / (\sqrt{\hat{v}_{t,i}} + \epsilon)$:

- Parameters with **large gradient magnitude** (large RMS, since $\hat{v}_{t,i}$ is the uncentered second moment, i.e. the mean of squared gradients) have large $\hat{v}_{t,i}$, so their effective learning rate is *smaller*. Adam normalizes by RMS magnitude, not by variance, so a large but consistent gradient is also damped.
- Parameters with **small gradient magnitude** (small RMS) have small $\hat{v}_{t,i}$, so their effective learning rate is *larger*, letting Adam make confident updates where the signal is small but steady.
- The bias correction is essential in the first few steps: without it, $m_t$ and $v_t$ are biased toward zero because they are initialized at zero and the exponential average has not converged.
</Remark>

<Example id="ex-adam-first-step">
**One Adam step with bias correction.** Take a single parameter with the default hyperparameters $\beta_1 = 0.9$, $\beta_2 = 0.999$, $\eta = 10^{-3}$, $\epsilon = 10^{-8}$, and initial moments $m_0 = v_0 = 0$. Suppose the first gradient is $g_1 = 0.1$.

The raw moment updates are
$$m_1 = 0.9 \cdot 0 + 0.1 \cdot 0.1 = 0.01, \qquad v_1 = 0.999 \cdot 0 + 0.001 \cdot (0.1)^2 = 10^{-5}.$$

Both are heavily shrunk toward zero by the initialization. The bias correction divides out exactly this shrinkage. At $t = 1$ the denominators are $1 - \beta_1^1 = 0.1$ and $1 - \beta_2^1 = 0.001$, so
$$\hat{m}_1 = \frac{0.01}{0.1} = 0.1, \qquad \hat{v}_1 = \frac{10^{-5}}{0.001} = 0.01.$$

Notice that after correction $\hat{m}_1 = g_1$ and $\hat{v}_1 = g_1^2$ exactly, recovering the true first-step statistics rather than the zero-biased ones. The parameter update is
$$\Delta\theta = -\,\eta\,\frac{\hat{m}_1}{\sqrt{\hat{v}_1} + \epsilon} = -\,10^{-3}\cdot\frac{0.1}{\sqrt{0.01} + 10^{-8}} \approx -\,10^{-3}\cdot\frac{0.1}{0.1} = -\,10^{-3}.$$

So the first step has magnitude $\approx \eta$, independent of the gradient scale: with $\hat{m}_1/\sqrt{\hat{v}_1} = g_1/|g_1| = \operatorname{sign}(g_1)$, Adam takes a step of size $\eta$ in the descent direction. Without bias correction, the same step would instead be $\eta\, m_1/\sqrt{v_1} = 10^{-3}\cdot 0.01/\sqrt{10^{-5}} \approx 3.2\times 10^{-3}$, more than triple the size, which is the wild early update that warmup exists to suppress.
</Example>

<Remark id="rmk-adamw">
**AdamW (decoupled weight decay)** [@loshchilov2019adamw]. In standard Adam, L2 regularization adds $\lambda \theta$ to the gradient, which then gets divided by $\sqrt{\hat{v}_t}$. This means the effective regularization strength varies per parameter, defeating the purpose of uniform weight decay. AdamW fixes this by applying weight decay *directly* to the parameters, outside the adaptive learning rate:

$$\theta_{t+1} = (1 - \eta \lambda) \theta_t - \eta \frac{\hat{m}_t}{\sqrt{\hat{v}_t} + \epsilon}$$

AdamW is the standard optimizer for transformer training. Typical hyperparameters: $\eta \in [10^{-5}, 10^{-3}]$, $\beta_1 = 0.9$, $\beta_2 \in [0.95, 0.999]$, weight decay $\lambda \in [0.01, 0.1]$.
</Remark>

## Other Optimizers

<Table id="tab-optimizers" caption="Overview of optimizers used in modern ML.">

| Optimizer | Update Rule (Simplified) | Memory | Key Property |
|-----------|-------------------------|--------|-------------|
| SGD | $\theta \leftarrow \theta - \eta g$ | $O(P)$ | Simple, good generalization |
| SGD + Momentum | $v \leftarrow \mu v + g$; $\theta \leftarrow \theta - \eta v$ | $O(2P)$ | Dampens oscillations |
| Adam | Uses $m_t, v_t$ as above | $O(3P)$ | Adaptive per-parameter rates |
| AdamW | Adam + decoupled weight decay | $O(3P)$ | Standard for transformers |
| Adafactor | Factored second moments | $O(P + \text{rows} + \text{cols})$ | Memory-efficient for large matrices |
| LAMB | Adam + layerwise LR scaling | $O(3P)$ | Large-batch training |
| Lion | Sign-based momentum update | $O(2P)$ | Memory-efficient, empirically strong |
| Muon | Orthogonalized momentum | $O(2P)$ | Emerging; strong empirical results |

</Table>

## Learning Rate Schedules

The learning rate $\eta_t$ is rarely constant. A schedule adapts it over training:

<Table id="tab-lr-schedules" caption="Common learning rate schedules.">

| Schedule | Formula | Typical Use |
|----------|---------|-----------|
| Constant | $\eta_t = \eta_0$ | Baselines, short fine-tuning |
| Step decay | $\eta_t = \eta_0 \cdot \gamma^{\lfloor t/s \rfloor}$ | CNNs (ResNet); $\gamma = 0.1$, $s$ at 30/60/90 epochs |
| Cosine annealing | $\eta_t = \eta_{\min} + \frac{1}{2}(\eta_0 - \eta_{\min})(1 + \cos(\pi t / T))$ | Transformer pretraining [@loshchilov2017sgdr] |
| Linear warmup + cosine | $\eta_t = \eta_0 \cdot \min(t/w, \; \frac{1}{2}(1+\cos(\pi(t-w)/(T-w))))$ | Standard for LLM pretraining |
| Warmup + inverse sqrt | $\eta_t = \eta_0 \cdot \min(t/w, \; \sqrt{w/t})$ | Original Transformer [@vaswani2017attention] |
| WSD (Warmup-Stable-Decay) | Warmup $\to$ constant $\to$ cosine decay | Practical for unknown training length |

</Table>

<Remark id="rmk-warmup">
**Why warmup?** In the first few steps, Adam's second-moment estimates $\hat{v}_t$ are based on very few samples and are unreliable. Large learning rates during this phase cause wild updates. Linear warmup (ramping $\eta$ from 0 to $\eta_0$ over $w$ steps) gives the adaptive estimates time to stabilize. Empirically, $w$ = 1 to 5% of total training steps works well.
</Remark>

## Gradient Clipping

<Definition id="def-gradient-clipping" name="Gradient Clipping">
To prevent exploding gradients, clip the gradient norm before applying the update:

<Equation id="eq-gradient-clipping">

$$g_t \leftarrow g_t \cdot \min\!\left(1, \; \frac{c}{\|g_t\|}\right)$$

</Equation>

where $c$ is the maximum allowed gradient norm (typically $c = 1.0$). This preserves the gradient direction but bounds its magnitude.
</Definition>

<Remark id="rmk-gradient-clipping-practice">
Gradient clipping is essential for training transformers and RNNs. Without it, a single batch with an unusually large loss can produce a gradient spike that destabilizes all the optimizer state (Adam's running averages get corrupted). A typical setting is `max_grad_norm=1.0` in both PyTorch and JAX training loops.
</Remark>

## Convergence Rate Summary

<Table id="tab-convergence-rates" caption="Convergence rates of gradient descent variants (simplified).">

| Setting | Algorithm | Rate | Metric |
|---------|-----------|------|--------|
| $L$-smooth convex | GD ($\eta = 1/L$) | $O(1/T)$ | $\mathcal{L}(\theta_T) - \mathcal{L}^*$ |
| $L$-smooth, $\mu$-strongly convex | GD ($\eta = 1/L$) | $O((1-\mu/L)^T)$ | $\mathcal{L}(\theta_T) - \mathcal{L}^*$ |
| $L$-smooth convex | Nesterov | $O(1/T^2)$ | $\mathcal{L}(\theta_T) - \mathcal{L}^*$ |
| $L$-smooth convex | SGD ($\eta \propto 1/\sqrt{T}$) | $O(1/\sqrt{T})$ | $\mathbb{E}[\mathcal{L}(\theta_T) - \mathcal{L}^*]$ |
| $L$-smooth non-convex | SGD ($\eta \propto 1/\sqrt{T}$) | $O(1/\sqrt{T})$ | $\frac{1}{T}\sum \mathbb{E}\|\nabla \mathcal{L}\|^2$ |

</Table>

<Remark id="rmk-convergence-practice">
These rates are worst-case. In practice, deep learning loss surfaces have favorable structure (saddle points are easily escaped, local minima are often near-global) that makes convergence faster than theoretical bounds suggest. The rates are most useful for comparing algorithms and understanding scaling behavior (e.g., doubling the number of SGD steps gives $\sqrt{2}\times$ improvement).
</Remark>

## Notation Summary

<Table id="tab-notation-gd" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $\theta$ | Model parameters |
| $\eta, \eta_t$ | Learning rate (possibly time-varying) |
| $\mathcal{L}$ | Loss function (empirical risk) |
| $\ell$ | Per-sample loss |
| $g_t$ | Gradient (or stochastic gradient) at step $t$ |
| $v_t$ | Velocity (momentum) or second moment (Adam) |
| $m_t$ | First moment estimate (Adam) |
| $\hat{m}_t, \hat{v}_t$ | Bias-corrected moment estimates |
| $\beta_1, \beta_2$ | Exponential decay rates (Adam) |
| $\mu$ | Momentum coefficient |
| $L$ | Lipschitz constant of the gradient ($L$-smoothness) |
| $\mu$ (strong convexity) | Strong convexity parameter |
| $\kappa = L/\mu$ | Condition number |
| $B = |\mathcal{B}|$ | Mini-batch size |
| $\sigma^2$ | Per-sample gradient variance |
| $c$ | Gradient clipping threshold |

</Table>
