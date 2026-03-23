---
sidebar_position: 11
title: "Sub-Quadratic Architectures"
---

## Sub-Quadratic Architectures

The quest for sub-quadratic alternatives to the Transformer has produced a diverse family of architectures that trade the full pairwise attention computation for more efficient sequence mixing mechanisms. While state space models (Section 3.5) represent one major branch of this effort, several other approaches have demonstrated competitive performance with fundamentally different architectural principles.

### Hyena

Poli et al. (2023) [@poli2023hyena] introduced Hyena, which replaces attention with a hierarchy of data-controlled long convolutions and element-wise gating. The key insight is that attention's effectiveness comes from two properties: (1) global receptive field (every token can attend to every other token) and (2) data-dependence (the mixing pattern depends on the input). Standard convolutions have property (1) if the kernel is long enough but lack property (2) -- the same filter is applied regardless of input. Hyena achieves both properties by using data-dependent gating to modulate the output of long convolutions, effectively creating input-dependent filters without the quadratic cost of computing all pairwise interactions. Hyena achieves sub-quadratic O(n log n) complexity (via FFT-based convolution) while maintaining the in-context learning capability that pure convolutional models lack. On language modeling benchmarks, Hyena matches attention-based models at sequence lengths up to 8K tokens while being significantly faster for longer sequences.

### RWKV

Peng et al. (2023) [@peng2023rwkv] proposed RWKV (Receptance Weighted Key Value), which combines the parallelizable training of Transformers with the efficient O(1)-per-token inference of RNNs. RWKV uses a linear attention variant called WKV (weighted key-value) that can be computed either as a parallel scan (during training, leveraging GPU parallelism) or as a recurrence (during inference, for constant-time per-token generation). The WKV mechanism uses exponential decay to weight past tokens, providing a learnable forgetting mechanism similar to gated RNNs but formulated to allow parallel computation. RWKV models up to 14B parameters have been trained and released as open-source, demonstrating that linear-complexity architectures can scale to sizes competitive with Transformer-based models like LLaMA [@touvron2023llama]. RWKV-v5 and v6 introduced data-dependent time mixing that further closes the gap with attention-based models.

### RetNet

Sun et al. (2023) [@sun2023retentive] proposed RetNet (Retentive Network), which introduces a dual form of computation called **multi-scale retention**. Retention can be expressed in three equivalent forms: (1) a parallel representation for training (analogous to attention), (2) a recurrent representation for efficient inference (O(1) per token), and (3) a chunk-wise representation that balances parallelism and memory. The multi-scale aspect uses different decay rates across heads, allowing different heads to attend to different temporal scales -- some heads focus on local context while others maintain longer-range dependencies. RetNet achieves competitive performance with Transformers on language modeling while offering O(n) training complexity and O(1) per-token inference, making it particularly attractive for deployment scenarios that prioritize inference efficiency.

### BASED

Arora et al. (2024) [@arora2024simple] proposed BASED, which combines linear attention with sliding-window attention in a hybrid design. The key insight is that linear attention handles global context efficiently (O(n) complexity for summarizing the full sequence into a fixed-size state) while local sliding-window attention captures fine-grained local patterns (O(n * w) for window size w). By allocating a small number of attention heads to local sliding-window attention and the majority to global linear attention, BASED achieves strong language modeling performance with sub-quadratic overall complexity. This hybrid approach reflects a general principle: the information processing requirements of language are heterogeneous, with some patterns requiring precise local matching (syntax, coreference) and others requiring broad contextual awareness (topic, discourse).

### Griffin and RecurrentGemma

De et al. (2024) [@de2024griffin] proposed Griffin, a hybrid architecture that combines gated linear recurrences with local attention. Griffin uses a recurrent block based on the Real-Gated Linear Recurrent Unit (RG-LRU) for global context aggregation and local multi-query attention for fine-grained token interactions. Google released RecurrentGemma models based on the Griffin architecture, demonstrating that hybrid recurrent-attention architectures can achieve comparable performance to pure Transformer models (Gemma) at the same scale while offering significantly faster inference for long sequences.

### xLSTM

Beck et al. (2024) [@beck2024xlstm] revisited the LSTM architecture with xLSTM (Extended LSTM), introducing exponential gating and a novel memory mixing mechanism that addresses the classical LSTM's limited memory capacity. The xLSTM family includes two variants: sLSTM (scalar LSTM with exponential gating and new memory mixing) and mLSTM (matrix LSTM with a matrix-valued memory state and covariance update rule). The mLSTM variant is particularly notable: by replacing the vector-valued cell state with a matrix, it bridges the gap between recurrent models and attention -- the matrix memory can be seen as a compressed version of the key-value cache in attention. xLSTM demonstrates that classical recurrent architectures, when modernized with insights from Transformers and SSMs, can be competitive with both on language modeling benchmarks up to 1.3B parameters.

### The Convergent Design Landscape

A striking pattern emerges across these architectures: despite their different origins (convolutions, RNNs, linear attention, gated recurrences), they are converging toward similar design principles. All successful sub-quadratic architectures incorporate: (1) data-dependent gating or selection mechanisms (Mamba's selective scan, Hyena's data-controlled convolutions, xLSTM's exponential gating), (2) some form of multi-scale processing (different heads or channels operating at different temporal resolutions), and (3) hardware-aware implementation strategies (parallel scan algorithms, FlashAttention-inspired memory management). The most successful recent models are hybrids that combine sub-quadratic global processing with local attention (BASED, Griffin, Jamba [@lieber2024jamba]), suggesting that a pure replacement for attention may be less important than finding the right combination of complementary mechanisms.
