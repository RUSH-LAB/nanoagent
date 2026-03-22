---
sidebar_position: 11
title: "Sub-Quadratic Architectures"
---

## Sub-Quadratic Architectures

Beyond SSMs, several other sub-quadratic architectures have been proposed.

### Hyena

Poli et al. (2023) [@poli2023hyena] introduced Hyena, which replaces attention with a hierarchy of data-controlled long convolutions and element-wise gating. Hyena achieves sub-quadratic complexity while maintaining the in-context learning capability that pure convolutional models lack. The data-dependent gating mechanism provides the selectivity that fixed convolutions miss.

### RWKV

Peng et al. (2023) [@peng2023rwkv] proposed RWKV, which combines the parallelizable training of Transformers with the efficient inference of RNNs. RWKV uses a linear attention variant called WKV (weighted key-value) that can be computed either as a parallel scan (during training) or as a recurrence (during inference). RWKV models up to 14B parameters have been trained, demonstrating that linear-complexity architectures can scale.

### BASED

Arora et al. (2024) [@arora2024simple] proposed BASED, which combines linear attention with sliding-window attention in a hybrid design. The key insight is that linear attention handles global context efficiently while local sliding-window attention captures fine-grained local patterns. BASED achieves strong language modeling performance with sub-quadratic complexity.

### xLSTM

Beck et al. (2024) [@beck2024xlstm] revisited the LSTM architecture with xLSTM (Extended LSTM), introducing exponential gating and a novel memory mixing mechanism. xLSTM demonstrates that classical recurrent architectures, when modernized with insights from Transformers and SSMs, can be competitive with both. The mLSTM variant in xLSTM uses a matrix-valued memory state, bridging the gap between recurrent models and attention.
