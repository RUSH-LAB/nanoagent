---
sidebar_position: 4
---

# Information Theory

## Entropy

<Definition id="def-entropy-it" name="Entropy">
The **entropy** of a discrete distribution $p$ measures uncertainty:

<Equation id="eq-entropy">

$$H(p) = -\sum_x p(x) \log p(x) = \mathbb{E}_{p}[-\log p(X)]$$

</Equation>

For continuous distributions, the **differential entropy** is $h(p) = -\int p(x) \log p(x) \, dx$.
</Definition>

Properties:

- $H(p) \geq 0$ (with equality iff $p$ is deterministic)
- For $K$ outcomes: $H(p) \leq \log K$ (equality iff $p$ is uniform)
- Adding noise increases entropy

<Remark id="rmk-entropy-meaning">
Entropy is the expected number of bits needed to encode samples from $p$. A high-entropy distribution is "uncertain" or "spread out." The uniform distribution maximizes entropy for a given support; the Gaussian maximizes entropy for a given mean and variance.
</Remark>

## Cross-Entropy

<Definition id="def-cross-entropy-it" name="Cross-Entropy">
The **cross-entropy** between a true distribution $p$ and a model $q$:

<Equation id="eq-cross-entropy-it">

$$H(p, q) = -\sum_x p(x) \log q(x) = H(p) + D_{\text{KL}}(p \| q)$$

</Equation>

Since $H(p)$ is constant during optimization, minimizing cross-entropy is equivalent to minimizing KL divergence.
</Definition>

<Remark id="rmk-cross-entropy-loss">
Cross-entropy loss in ML is exactly this quantity. For classification, $p$ is the one-hot label distribution and $q$ is the model's softmax output. Minimizing cross-entropy loss trains the model to match the data distribution.
</Remark>

## KL Divergence

<Definition id="def-kl-it" name="KL Divergence">
The **Kullback-Leibler divergence** from $q$ to $p$ [@kullback1951information]:

<Equation id="eq-kl-it">

$$D_{\text{KL}}(p \| q) = \sum_x p(x) \log \frac{p(x)}{q(x)} \geq 0$$

</Equation>

Properties: non-negative (Gibbs' inequality), zero iff $p = q$, **not symmetric**, does not satisfy triangle inequality.
</Definition>

<Table id="tab-kl-directions" caption="Forward vs reverse KL divergence behavior.">

| Direction | Behavior | Name |
|-----------|----------|------|
| $D_{\text{KL}}(p \| q)$ | $q$ must cover all modes of $p$ | Forward KL (mean-seeking) |
| $D_{\text{KL}}(q \| p)$ | $q$ concentrates on one mode of $p$ | Reverse KL (mode-seeking) |

</Table>

<Remark id="rmk-kl-direction-ml">
MLE minimizes $D_{\text{KL}}(p_{\text{data}} \| p_{\theta})$ (forward KL). VAEs minimize reverse KL $D_{\text{KL}}(q_\phi \| p)$ in the ELBO. GANs approximate forward KL. The choice of KL direction determines whether the model is mode-covering or mode-seeking.
</Remark>

## Mutual Information

<Definition id="def-mutual-info" name="Mutual Information">
The **mutual information** between $X$ and $Y$ measures how much knowing one tells you about the other:

<Equation id="eq-mutual-info">

$$I(X; Y) = D_{\text{KL}}(p(X, Y) \| p(X)p(Y)) = H(X) - H(X|Y) = H(Y) - H(Y|X)$$

</Equation>

Properties: $I(X;Y) \geq 0$, $I(X;Y) = 0$ iff $X \perp Y$, symmetric.
</Definition>

<Remark id="rmk-mutual-info-ml">
Mutual information captures all dependencies (not just linear). It is used in feature selection, representation learning (InfoNCE loss) [@oord2018infonce], and as a measure of representation quality.
</Remark>

## Data Processing Inequality

<Theorem id="thm-data-processing" name="Data Processing Inequality">
For a Markov chain $X \to Y \to Z$ (i.e., $Z$ depends on $X$ only through $Y$):

<Equation id="eq-data-processing">

$$I(X; Z) \leq I(X; Y)$$

</Equation>

Processing data can only lose information, never create it.
</Theorem>

<Remark id="rmk-data-processing-nn">
In a neural network $X \to h_1 \to h_2 \to \cdots \to \hat{Y}$, each layer forms a Markov chain. The data processing inequality tells us that later layers cannot recover information lost by earlier layers. This motivates careful design of early layers and skip connections.
</Remark>

## Notation Summary

<Table id="tab-notation-info" caption="Notation used in information theory.">

| Symbol | Meaning |
|--------|---------|
| $H(p)$ | Entropy of distribution $p$ |
| $H(p, q)$ | Cross-entropy between $p$ and $q$ |
| $D_{\text{KL}}(p \| q)$ | KL divergence from $q$ to $p$ |
| $I(X; Y)$ | Mutual information between $X$ and $Y$ |
| $H(X|Y)$ | Conditional entropy |
| $\log$ | Natural logarithm (nats) or $\log_2$ (bits) |

</Table>
