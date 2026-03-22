---
sidebar_position: 7
title: "Meta-Continual Learning"
---

# Meta-Continual Learning

Meta-learning approaches aim to learn initialization or update rules that are inherently amenable to continual learning.

### Online Meta-Learning (OML)

Javed and White (2019) [@javed2019meta] proposed OML, which meta-learns a representation that is robust to catastrophic forgetting. OML uses a MAML-like outer loop where the meta-objective explicitly penalizes forgetting during the inner loop updates. The learned representation generalizes well to long task sequences.

### A Neuromodulated Meta-Learning Algorithm (ANML)

Beaulieu et al. (2020) [@beaulieu2020learning] introduced ANML, which adds a neuromodulatory network that gates activations during learning. The neuromodulator is meta-learned to selectively protect important features while allowing plasticity for new learning. This biologically inspired approach outperforms OML on several benchmarks.

### La-MAML

Gupta et al. (2020) [@gupta2020lamaml] proposed La-MAML (Look-Ahead Meta Learning for Continual Learning), which modulates the per-parameter learning rates based on the look-ahead loss on a meta-objective that includes both current and previous task performance. La-MAML achieves strong performance on both task-incremental and class-incremental settings while being more computationally efficient than standard MAML-based approaches.

### Meta-Continual Learning with Replay (MRCL)

MRCL combines meta-learning with replay, learning representations that are specifically optimized for replay-based continual learning [@arani2022learning]. The meta-objective ensures that a small number of replay samples is maximally effective for retaining previous task knowledge.
