---
sidebar_position: 3
---

# Non-Convex Optimization

Neural network loss functions are non-convex in their parameters. Despite the lack of convexity guarantees, stochastic gradient descent reliably finds good solutions. Understanding *why* requires studying the geometry of the loss landscape and the implicit biases of optimization algorithms.

## The Non-Convex Landscape of Deep Learning

A network with $P$ parameters defines a loss surface $\mathcal{L}: \mathbb{R}^P \to \mathbb{R}$. This surface has an astronomical number of critical points (where $\nabla \mathcal{L} = 0$), and most of them are saddle points, not minima.

## Saddle Points vs. Local Minima

<Definition id="def-saddle-point" name="Saddle Point">
A critical point $\theta^*$ (where $\nabla \mathcal{L}(\theta^*) = 0$) is a **saddle point** if the Hessian $H = \nabla^2 \mathcal{L}(\theta^*)$ has both positive and negative eigenvalues. The number of negative eigenvalues is called the **index** of the saddle point.
</Definition>

<Theorem id="thm-saddle-dominance" name="Saddle Point Dominance in High Dimensions">
For a random critical point in $P$ dimensions (under mild assumptions), the probability of being a local minimum is:

<Equation id="eq-saddle-probability">

$$P(\text{local minimum}) \approx 2^{-P}$$

</Equation>

since each Hessian eigenvalue must be positive independently. For $P = 10^8$ (a 100M parameter model), this probability is less than $10^{-30000000}$.
</Theorem>

<Remark id="rmk-saddle-not-minima">
The practical implication: **the main obstacle to optimization is not bad local minima but saddle points and plateaus.** SGD's stochastic noise naturally helps escape saddle points because the noise has a component along the negative curvature directions, pushing the iterate away from the saddle. Formal results show that perturbed gradient descent escapes strict saddle points in polynomial time [@jin2017escape].
</Remark>

## Loss Surface Geometry

Empirical and theoretical studies have revealed rich structure in neural network loss landscapes:

<Table id="tab-loss-surface" caption="Empirical properties of neural network loss landscapes.">

| Property | Observation | Implication |
|----------|-------------|-------------|
| **Flat vs. sharp minima** | SGD converges to wide, flat valleys; large-batch GD finds sharper minima [@keskar2017large] | Flat minima generalize better (robust to weight perturbation) |
| **Mode connectivity** | Good local minima are connected by paths with low loss [@draxler2018essentially; @garipov2018loss] | The "loss landscape" is more like a connected valley than isolated basins |
| **Linear mode connectivity** | Checkpoints from the same run can be linearly interpolated with monotone loss [@frankle2020linear] | Simplifies model averaging and ensembling |
| **Edge of stability** | GD with large LR evolves the Hessian so $\lambda_{\max}(H) \approx 2/\eta$ [@cohen2021gradient] | Training self-organizes to the stability boundary |
| **Loss landscape simplification** | BatchNorm, skip connections, and overparameterization smooth the landscape [@li2018visualizing] | Architecture design = implicit optimization design |
| **Progressive sharpening** | Training loss surface becomes sharper over training [@jastrzebski2020break] | Motivates learning rate decay |

</Table>

<Remark id="rmk-edge-of-stability">
**Edge of stability.** Classical optimization theory says GD converges only if $\eta < 2/\lambda_{\max}(H)$. Cohen et al. (2021) showed that in practice, GD first increases $\lambda_{\max}$ until it reaches $\approx 2/\eta$, then oscillates at this boundary while still decreasing the loss monotonically (in a time-averaged sense). This "edge of stability" phenomenon is not predicted by any existing convergence theory and suggests that neural network training dynamics are qualitatively different from classical optimization.
</Remark>

<Remark id="rmk-flat-minima">
**Why flat minima generalize.** A minimum is "flat" if the loss surface curves gently around it: small perturbations to $\theta$ cause small changes in $\mathcal{L}$. Formally, if $\theta^*$ is in a flat minimum, then for a random perturbation $\delta$ with $\|\delta\| = \epsilon$:

$$|\mathcal{L}(\theta^* + \delta) - \mathcal{L}(\theta^*)| \leq \frac{1}{2}\epsilon^2 \lambda_{\max}(H)$$

A smaller $\lambda_{\max}$ (flatter) means the loss is robust to the weight perturbations that occur when moving from training to test data. This is formalized by PAC-Bayesian generalization bounds [@mcallester1999pac], which relate generalization to the volume of parameter space around $\theta^*$ with low loss.
</Remark>

## Why Deep Networks Train Despite Non-Convexity

Several factors explain the empirical success:

<Table id="tab-why-training-works" caption="Factors that make non-convex optimization tractable for neural networks.">

| Factor | Mechanism | Evidence |
|--------|-----------|----------|
| **Overparameterization** | $P \gg N$ creates many global minima; gradient descent reaches one [@du2019gradient] | Networks with more parameters are *easier* to train |
| **SGD noise** | Stochastic gradients escape saddle points and sharp minima | Small-batch training generalizes better [@keskar2017large] |
| **Skip connections** | Residual connections create smooth loss surfaces | ResNets train where plain networks fail [@he2016resnet] |
| **Normalization** | BatchNorm/LayerNorm smooth the loss landscape | Enables much larger learning rates [@ioffe2015batch; @santurkar2018does] |
| **Initialization** | He/Xavier initialization places $\theta_0$ in a well-behaved region | Bad initialization causes vanishing/exploding gradients |
| **Implicit regularization** | SGD's trajectory has an inductive bias toward simple solutions | Minimum-norm solutions in linear models [@gunasekar2018characterizing] |
| **Progressive learning** | Warmup + LR decay matches training phases to landscape geometry | Standard in all large-scale training |

</Table>

<Remark id="rmk-lazy-training">
**Overparameterization regimes.** In the extreme overparameterization limit, the **Neural Tangent Kernel (NTK)** regime [@jacot2018neural], the network behaves like a linear model in a kernel space defined by the initialization. Training is approximately convex, and the dynamics are well-understood. Real networks operate in a "rich" or "feature learning" regime that is harder to analyze but achieves better performance.
</Remark>

## Escaping Bad Regions

<Table id="tab-escape-strategies" caption="Strategies for escaping saddle points and local minima.">

| Strategy | How It Works | Used In |
|----------|-------------|---------|
| **SGD noise** | Gradient noise provides random perturbation | Standard training |
| **Learning rate warmup** | Gradually increases LR to avoid early sharp minima | Transformer pretraining |
| **Cyclic LR / restarts** | Periodic LR increases to escape local basins | SGDR [@loshchilov2017sgdr] |
| **Gradient clipping** | Bounds gradient magnitude to prevent overshooting | RNNs, transformers |
| **Sharpness-aware minimization (SAM)** | Minimizes worst-case loss in a neighborhood | Improves generalization [@foret2021sam] |
| **Stochastic weight averaging (SWA)** | Averages weights along the trajectory | Better generalization, flatter minima |
| **Exponential moving average (EMA)** | Maintains running average of weights | Standard in modern training |

</Table>

## Learning Rate Schedules

The learning rate is the single most important hyperparameter. It controls the noise scale ($\propto \eta / B$), the convergence speed, and the type of minimum found.

**Warmup** starts with a small LR and linearly increases to the target:

<Equation id="eq-warmup">

$$\eta_t = \eta_{\max} \cdot \min\left(\frac{t}{w}, \, 1\right) \quad \text{for } t \leq w$$

</Equation>

**Cosine decay** smoothly decreases the LR:

<Equation id="eq-cosine-decay">

$$\eta_t = \eta_{\min} + \frac{1}{2}(\eta_{\max} - \eta_{\min})\left(1 + \cos\left(\frac{\pi (t - w)}{T - w}\right)\right) \quad \text{for } t > w$$

</Equation>

<Remark id="rmk-schedule-phases">
**Three phases of training:**

1. **Warmup phase** ($t < w$): LR ramps from 0 to $\eta_{\max}$. Adam's second-moment estimates ($\hat{v}_t$) are unreliable initially; warmup gives them time to stabilize. The loss drops rapidly during warmup.
2. **Stable phase** ($w < t < T_{\text{decay}}$): LR is near $\eta_{\max}$. The model explores the loss landscape, learning features and escaping shallow minima. Most learning happens here.
3. **Decay phase** ($t > T_{\text{decay}}$): LR decreases toward $\eta_{\min}$. The optimizer refines its solution, settling into a flat minimum. The loss decreases slowly but generalization improves.

The **WSD (Warmup-Stable-Decay)** schedule makes this explicit: warmup for 5% of training, constant LR for ~75%, then cosine decay for the final ~20%. This is increasingly popular because it does not require knowing the total training length in advance.
</Remark>

<Table id="tab-lr-schedules-opt" caption="Learning rate schedules and their typical use cases.">

| Schedule | Formula | Best For | Key Parameter |
|----------|---------|----------|---------------|
| Constant | $\eta_t = \eta_0$ | Fine-tuning, short runs | $\eta_0$ |
| Step decay | $\eta_t = \eta_0 \gamma^{\lfloor t/s \rfloor}$ | CNNs (ResNet) | $\gamma = 0.1$, steps at 30/60/90 epochs |
| Cosine annealing | $\frac{1}{2}\eta_0(1 + \cos(\pi t/T))$ | Pretraining | Min LR, $T$ |
| Warmup + cosine | Linear warmup then cosine | LLM pretraining | Warmup steps $w$ |
| WSD | Warmup $\to$ constant $\to$ cosine | Flexible pretraining | Phase boundaries |
| 1-cycle | Ramp up then down | Fast convergence | Max LR, $T$ |
| Inverse sqrt | $\eta_0 / \sqrt{t}$ | Original Transformer | $\eta_0$ |

</Table>

## Notation Summary

<Table id="tab-notation-nonconvex" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $P$ | Number of model parameters |
| $\lambda_{\max}(H)$ | Largest eigenvalue of the Hessian |
| $\eta, \eta_t$ | Learning rate (possibly time-varying) |
| $w$ | Number of warmup steps |
| $T$ | Total training steps |
| $\eta_{\min}, \eta_{\max}$ | Minimum and maximum learning rate |
| $\gamma$ | Decay factor for step schedule |
| $\kappa$ | Condition number |
| SAM | Sharpness-Aware Minimization |
| SWA | Stochastic Weight Averaging |
| EMA | Exponential Moving Average |
| NTK | Neural Tangent Kernel |

</Table>
