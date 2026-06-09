# Probability and Statistics

Probability is the other foundational language of machine learning. Models define distributions, training maximizes likelihood, and generalization is a statistical guarantee.

These five sections build on one another. The basics fix the vocabulary of events, conditioning, and expectation; distributions give the concrete families that models assume; the likelihoods from those distributions feed Bayesian inference, where priors and data combine into posteriors; information theory measures the distances between distributions that show up as training objectives; and statistical learning theory turns all of this into guarantees about how well a fitted model will generalize.

- **[Probability Basics](./1-probability-basics.md)**: Axioms, conditional probability, Bayes' theorem, expectation, variance
- **[Distributions](./2-distributions.md)**: Bernoulli, Gaussian, Categorical (and softmax), multivariate Gaussian, mixture models
- **[Bayesian Inference](./3-bayesian-inference.md)**: Prior, likelihood, posterior, MAP vs MLE, variational inference
- **[Information Theory](./4-information-theory.md)**: Entropy, cross-entropy, KL divergence, mutual information
- **[Statistical Learning Theory](./5-statistical-learning.md)**: PAC learning, VC dimension, generalization bounds, bias-variance decomposition
