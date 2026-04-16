---
sidebar_position: 5
---

# Regularization

Regularization is the set of techniques that constrain a model to prefer simpler hypotheses, preventing it from memorizing the training set at the expense of generalization. Understanding regularization requires understanding *why* overfitting occurs and *how* different regularizers address the underlying causes.

## The Overfitting Problem

A model with sufficient capacity can achieve zero training loss ($\mathcal{L}_{\text{train}} \approx 0$) by memorizing every training example, including noise. However, such a model performs poorly on unseen data ($\mathcal{L}_{\text{test}} \gg 0$) because it has learned patterns specific to the training set rather than the underlying data-generating process. The **generalization gap** $\mathcal{L}_{\text{test}} - \mathcal{L}_{\text{train}}$ measures the severity of overfitting.

<Remark id="rmk-overfit-capacity">
A remarkable fact: a neural network with $P$ parameters can memorize a dataset of $N \leq P$ random label assignments -- where the labels bear no relation to the inputs [@zhang2021understanding]. This proves that the model class alone does not determine generalization; the training procedure and data structure also matter.
</Remark>

## L2 Regularization (Ridge / Weight Decay)

<Definition id="def-l2-reg" name="L2 Regularization">
Add the squared Euclidean norm of parameters to the loss:

<Equation id="eq-l2-reg">

$$\mathcal{L}_{\text{reg}}(\theta) = \mathcal{L}(\theta) + \frac{\lambda}{2} \|\theta\|_2^2 = \mathcal{L}(\theta) + \frac{\lambda}{2} \sum_i \theta_i^2$$

</Equation>

where $\lambda > 0$ controls the regularization strength.
</Definition>

The gradient of the regularized loss is $\nabla \mathcal{L}_{\text{reg}} = \nabla \mathcal{L} + \lambda \theta$, giving the SGD update:

<Equation id="eq-weight-decay">

$$\theta_{t+1} = \theta_t - \eta(\nabla \mathcal{L}(\theta_t) + \lambda \theta_t) = (1 - \eta\lambda)\theta_t - \eta \nabla \mathcal{L}(\theta_t)$$

</Equation>

The multiplicative factor $(1 - \eta\lambda)$ shrinks every weight toward zero each step, hence the name **weight decay**.

<Remark id="rmk-l2-bayesian">
**Bayesian interpretation.** L2 regularization is equivalent to placing a Gaussian prior $p(\theta) \propto \exp(-\lambda\|\theta\|^2/2)$ on the parameters. Minimizing $\mathcal{L}_{\text{reg}}$ is equivalent to computing the **maximum a posteriori (MAP)** estimate:

$$\theta_{\text{MAP}} = \arg\max_\theta \; p(\mathcal{D}|\theta) \cdot p(\theta) = \arg\min_\theta \; \underbrace{-\log p(\mathcal{D}|\theta)}_{\mathcal{L}(\theta)} + \underbrace{\frac{\lambda}{2}\|\theta\|^2}_{-\log p(\theta) + \text{const}}$$

Larger $\lambda$ corresponds to a tighter prior -- a stronger belief that parameters should be small.
</Remark>

<Remark id="rmk-weight-decay-adamw">
**L2 regularization $\neq$ weight decay for adaptive optimizers.** For SGD, adding $\frac{\lambda}{2}\|\theta\|^2$ to the loss is equivalent to multiplying $\theta$ by $(1 - \eta\lambda)$ each step. For Adam, the L2 gradient term $\lambda\theta$ gets divided by $\sqrt{\hat{v}_t}$, making the effective regularization strength parameter-dependent and inconsistent. **AdamW** [@loshchilov2019adamw] fixes this by applying weight decay directly: $\theta \leftarrow (1 - \eta\lambda)\theta - \eta \cdot \text{Adam\_step}$, decoupling regularization from the adaptive learning rate. AdamW is the standard for transformer training.
</Remark>

<Example id="ex-l2-ridge-regression">
**Closed-form for linear regression.** For $\mathcal{L} = \|y - X\theta\|^2 + \lambda\|\theta\|^2$, the solution is:

$$\theta_{\text{ridge}} = (X^\top X + \lambda I)^{-1} X^\top y$$

The term $\lambda I$ ensures the matrix is invertible even when $X^\top X$ is singular (more features than samples). Geometrically, it shrinks the OLS solution toward zero along directions of small variance in $X$.
</Example>

## L1 Regularization (Lasso)

<Definition id="def-l1-reg" name="L1 Regularization">
Add the sum of absolute values of parameters:

<Equation id="eq-l1-reg">

$$\mathcal{L}_{\text{reg}}(\theta) = \mathcal{L}(\theta) + \lambda \|\theta\|_1 = \mathcal{L}(\theta) + \lambda \sum_i |\theta_i|$$

</Equation>
</Definition>

<Remark id="rmk-l1-sparsity">
**Why L1 produces sparsity.** The subgradient of $|\theta_i|$ is $\text{sign}(\theta_i)$, which applies constant pressure of magnitude $\lambda$ regardless of how small $\theta_i$ is. Once $|\theta_i|$ is small enough that this pressure dominates the data gradient, $\theta_i$ is driven exactly to zero. In contrast, L2's gradient $\lambda \theta_i$ diminishes as $\theta_i \to 0$, never reaching zero.

**Geometric interpretation:** The L1 constraint set $\|\theta\|_1 \leq c$ is a diamond (cross-polytope) with corners on the coordinate axes. The loss function's level curves are more likely to first touch a corner of the diamond than a smooth point -- and corners correspond to sparse solutions (some coordinates exactly zero).
</Remark>

<Table id="tab-l1-vs-l2" caption="Comparison of L1 and L2 regularization.">

| Property | L1 (Lasso) | L2 (Ridge) |
|----------|----|----|
| Penalty | $\lambda \sum |\theta_i|$ | $\frac{\lambda}{2} \sum \theta_i^2$ |
| Effect on parameters | Sparse (many exactly zero) | Small (all shrunk, none exactly zero) |
| Bayesian prior | Laplace: $p(\theta_i) \propto e^{-\lambda|\theta_i|}$ | Gaussian: $p(\theta_i) \propto e^{-\lambda\theta_i^2/2}$ |
| Constraint geometry | Diamond (cross-polytope) | Sphere (ball) |
| Feature selection | Yes (implicit) | No |
| Smoothness | Non-differentiable at $\theta_i = 0$ | Smooth everywhere |
| Use in deep learning | Rare (non-smooth optimization) | Standard (as weight decay) |

</Table>

<Remark id="rmk-elastic-net">
**Elastic Net** combines both: $\lambda_1 \|\theta\|_1 + \frac{\lambda_2}{2}\|\theta\|_2^2$. This encourages sparsity (L1) while handling correlated features gracefully (L2). In deep learning, a practical approximation is weight decay (L2) with structured pruning (explicit sparsity).
</Remark>

## Dropout

<Definition id="def-dropout" name="Dropout">
During training, independently set each neuron's activation to zero with probability $p$ (the **drop rate**, typically $p = 0.1$ to $0.5$) [@srivastava2014dropout]:

<Equation id="eq-dropout">

$$h^{\text{drop}} = h \odot m, \quad m_i \sim \text{Bernoulli}(1 - p)$$

</Equation>

To maintain the expected activation magnitude, **inverted dropout** scales by $1/(1-p)$ during training:

$$\text{Train: } \quad \tilde{h} = \frac{1}{1 - p} \cdot h \odot m \qquad \text{Test: } \quad \tilde{h} = h$$

This way, no modification is needed at test time.
</Definition>

<Remark id="rmk-dropout-ensemble">
**Dropout as ensemble averaging.** A network with $n$ units and dropout samples from $2^n$ possible sub-networks (one for each dropout mask). At test time, using all units (with properly scaled weights) approximates the geometric mean of all sub-network predictions. This ensemble interpretation explains dropout's regularization effect: no single sub-network can rely on any other neuron, forcing redundant representations.
</Remark>

<Remark id="rmk-dropout-modern">
**Dropout in modern architectures.** Dropout is less common in modern transformers than in older architectures:

- **Vision Transformers (ViT):** Often use no dropout or very low rates, relying instead on data augmentation and weight decay.
- **LLMs:** Typically do not use dropout during pretraining (GPT-3, LLaMA), as the massive dataset size provides implicit regularization.
- **Where it persists:** Attention dropout (dropping attention weights) and path dropout / DropPath (dropping entire residual branches) remain useful, especially when data is limited.
</Remark>

## Batch Normalization and Layer Normalization

<Definition id="def-batch-norm" name="Batch Normalization">
**Batch normalization** [@ioffe2015batch] normalizes activations across the batch dimension, then applies a learned affine transformation:

<Equation id="eq-batch-norm">

$$\hat{h}_i = \gamma \cdot \frac{h_i - \mu_{\mathcal{B}}}{\sqrt{\sigma_{\mathcal{B}}^2 + \epsilon}} + \beta$$

</Equation>

where $\mu_{\mathcal{B}} = \frac{1}{B}\sum_{i=1}^B h_i$ and $\sigma_{\mathcal{B}}^2 = \frac{1}{B}\sum_{i=1}^B (h_i - \mu_{\mathcal{B}})^2$ are the batch mean and variance, and $\gamma, \beta$ are learnable scale and shift parameters.
</Definition>

<Definition id="def-layer-norm" name="Layer Normalization">
**Layer normalization** [@ba2016layer] normalizes across the feature dimension instead of the batch dimension:

<Equation id="eq-layer-norm">

$$\hat{h}_j = \gamma_j \cdot \frac{h_j - \mu_h}{\sqrt{\sigma_h^2 + \epsilon}} + \beta_j$$

</Equation>

where $\mu_h = \frac{1}{d}\sum_{j=1}^d h_j$ and $\sigma_h^2 = \frac{1}{d}\sum_{j=1}^d (h_j - \mu_h)^2$ are computed over the $d$ features for each sample independently.
</Definition>

<Remark id="rmk-norm-comparison">
**When to use which:** BatchNorm works well for CNNs with large, fixed batch sizes but breaks down when batch size is small or the batch statistics are unreliable (e.g., distributed training with small per-GPU batches). LayerNorm is independent of batch size and is the standard for transformers and sequence models. **RMSNorm** ($\hat{h} = h / \sqrt{\frac{1}{d}\sum h_j^2 + \epsilon}$, without mean subtraction) is increasingly preferred for LLMs due to simplicity and slight speed advantage.
</Remark>

## Early Stopping

<Definition id="def-early-stopping" name="Early Stopping">
Monitor validation loss during training and stop when it begins to increase:

<Equation id="eq-early-stopping">

$$\theta^* = \theta_{t^*}, \quad t^* = \arg\min_{t \leq T} \mathcal{L}_{\text{val}}(\theta_t)$$

</Equation>

In practice, use **patience** $k$: stop if validation loss has not improved for $k$ consecutive evaluations. Save the best checkpoint.
</Definition>

<Remark id="rmk-early-stopping-l2">
**Connection to L2 regularization.** For linear regression with gradient descent and small learning rate, early stopping after $t$ steps is equivalent to L2 regularization with $\lambda \approx 1/(\eta t)$ [@bishop2006pattern]. Intuitively, the number of training steps limits how far $\theta$ can move from its initialization (which acts as a zero prior). More steps $=$ less regularization.
</Remark>

## Data Augmentation

<Remark id="rmk-data-augmentation">
**Data augmentation** is a form of regularization that increases the effective dataset size by applying label-preserving transformations. Common augmentations:

| Domain | Augmentations |
|--------|--------------|
| Vision | Random crop, horizontal flip, color jitter, RandAugment, Mixup, CutMix |
| Text | Token masking (BERT), back-translation, synonym replacement, dropout on embeddings |
| Audio | Time stretching, pitch shifting, SpecAugment (masking frequency/time bands) |

**Mixup** [@zhang2018mixup] creates virtual training examples by linearly interpolating both inputs and labels: $\tilde{x} = \lambda x_i + (1-\lambda) x_j$, $\tilde{y} = \lambda y_i + (1-\lambda) y_j$ where $\lambda \sim \text{Beta}(\alpha, \alpha)$.
</Remark>

## Bias--Variance Tradeoff

<Theorem id="thm-bias-variance" name="Bias--Variance Decomposition">
For a model $\hat{f}$ trained on dataset $\mathcal{D}$ drawn from $P(X,Y)$ with $Y = f(X) + \epsilon$, $\epsilon \sim (0, \sigma^2)$, the expected prediction error at a point $x$ decomposes as:

<Equation id="eq-bias-variance">

$$\mathbb{E}_{\mathcal{D}}\!\left[(y - \hat{f}(x))^2\right] = \underbrace{\left(\mathbb{E}_{\mathcal{D}}[\hat{f}(x)] - f(x)\right)^2}_{\text{Bias}^2} + \underbrace{\mathbb{E}_{\mathcal{D}}\!\left[(\hat{f}(x) - \mathbb{E}_{\mathcal{D}}[\hat{f}(x)])^2\right]}_{\text{Variance}} + \underbrace{\sigma^2}_{\text{Irreducible noise}}$$

</Equation>

The expectation is over different training sets $\mathcal{D}$ drawn from the same distribution.
</Theorem>

**Proof.** Let $\bar{f}(x) = \mathbb{E}_{\mathcal{D}}[\hat{f}(x)]$. Then:

$$\mathbb{E}[(y - \hat{f})^2] = \mathbb{E}[(y - f + f - \bar{f} + \bar{f} - \hat{f})^2]$$

Expanding and noting that cross terms vanish (since $\mathbb{E}[\epsilon] = 0$ and $\mathbb{E}[\hat{f} - \bar{f}] = 0$ by definition, and $\epsilon$ is independent of $\hat{f}$):

$$= \mathbb{E}[\epsilon^2] + (f - \bar{f})^2 + \mathbb{E}[(\hat{f} - \bar{f})^2] = \sigma^2 + \text{Bias}^2 + \text{Variance} \quad \square$$

<Table id="tab-bias-variance" caption="Bias-variance tradeoff regimes and the effect of regularization.">

| Regime | Bias | Variance | Model Behavior | Fix |
|--------|------|----------|----------------|-----|
| **Underfitting** | High | Low | Model too simple; misses patterns | Increase capacity, reduce regularization |
| **Overfitting** | Low | High | Model memorizes noise | Increase regularization, more data |
| **Sweet spot** | Balanced | Balanced | Best generalization | -- |
| **Double descent** | Low | Low (surprisingly) | Very overparameterized | Let model grow past interpolation threshold |

</Table>

<Remark id="rmk-double-descent">
**Double descent.** Classical theory predicts that test error follows a U-shaped curve as model capacity increases (underfitting $\to$ optimal $\to$ overfitting). However, modern deep learning exhibits **double descent** [@belkin2019reconciling; @nakkiran2021deep]: test error peaks at the interpolation threshold (where the model can just barely fit the training data) and then *decreases* as capacity increases further into the overparameterized regime. This is partly explained by:

1. **Implicit regularization** from SGD, which finds minimum-norm solutions in the overparameterized regime
2. **Inductive biases** of neural network architectures (locality, weight sharing)
3. **Benign overfitting** -- the model interpolates training data but does so smoothly, with low test error
</Remark>

## Summary of Regularization Techniques

<Table id="tab-regularization-summary" caption="Summary of regularization techniques and their mechanisms.">

| Technique | Mechanism | Computational Cost | Modern Usage |
|-----------|-----------|-------------------|-------------|
| L2 / Weight decay | Shrinks weights toward zero | Negligible | Standard (AdamW) |
| L1 | Drives weights to exactly zero | Negligible | Rare in deep learning |
| Dropout | Random neuron zeroing; ensemble effect | ~10% training overhead | Declining; used in attention/path |
| BatchNorm | Normalizes by batch stats; adds noise | ~5% overhead | CNNs |
| LayerNorm / RMSNorm | Normalizes by feature stats | ~5% overhead | Transformers, LLMs |
| Data augmentation | Increases effective dataset size | Data pipeline overhead | Standard for vision |
| Early stopping | Limits optimization trajectory | None (saves compute) | Standard |
| Label smoothing | Softens one-hot targets | Negligible | Common for classification |
| Gradient clipping | Bounds gradient magnitude | Negligible | Standard for transformers |

</Table>

## Notation Summary

<Table id="tab-notation-reg" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $\lambda$ | Regularization strength / weight decay coefficient |
| $\|\theta\|_1, \|\theta\|_2$ | L1 and L2 norms of parameters |
| $p$ | Dropout probability (drop rate) |
| $m$ | Binary dropout mask |
| $\odot$ | Elementwise product |
| $\gamma, \beta$ | Learnable scale and shift in normalization |
| $\mu_{\mathcal{B}}, \sigma_{\mathcal{B}}^2$ | Batch mean and variance |
| $\hat{f}$ | Learned predictor (random variable over training sets) |
| $f$ | True function |
| $\sigma^2$ | Irreducible noise variance |
| $\mathcal{L}_{\text{val}}$ | Validation loss |

</Table>
