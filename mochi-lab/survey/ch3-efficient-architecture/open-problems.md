---
sidebar_position: 13
title: "Open Problems & Future Directions"
---

## Open Problems & Future Directions

### Scaling Laws for Efficient Architectures

While we have well-established scaling laws for dense Transformers [@kaplan2020scaling, @hoffmann2022training], equivalent laws for MoE models, SSMs, and hybrid architectures are still nascent. Key open questions include: How do MoE scaling laws differ from dense scaling laws? (Preliminary evidence suggests MoE achieves better compute-efficiency but follows different model-size scaling.) How do SSM scaling laws compare to Transformer scaling laws? (Mamba appears to track Transformer scaling curves, but this has been verified only at moderate scale.) What are the scaling laws for hybrid architectures, and how does the optimal SSM-to-attention ratio change with scale? Understanding these laws is critical for making informed architectural decisions at the frontier, where a single training run costs tens of millions of dollars.

### Dynamic Compute Allocation

Current architectures allocate fixed compute per token (or per expert in MoE), but some tokens are "harder" than others -- a period requires less computation than a complex mathematical derivation, yet both receive the same forward pass. **Adaptive computation** -- allocating more compute to difficult inputs and less to easy ones -- could dramatically improve average efficiency.

**Early exit** methods [@schuster2022confident] allow the model to stop processing at an intermediate layer if it is already confident in its prediction, saving the compute of the remaining layers. **Mixture-of-Depths** [@raposo2024mixture] extends conditional computation from the expert dimension (MoE) to the depth dimension, routing tokens through a variable number of layers based on a learned routing function. **Adaptive precision** allocates different numerical precision to different tokens based on their difficulty.

The fundamental challenge is learning a reliable difficulty estimator that is itself cheap to compute. If estimating difficulty costs as much as solving the problem, adaptive computation provides no benefit. The field needs lightweight, reliable difficulty predictors that enable meaningful compute savings.

### Co-Design of Algorithms and Hardware

The gap between theoretical algorithmic efficiency and practical hardware efficiency remains large. FlashAttention demonstrated that IO-aware algorithm design can achieve speedups comparable to algorithmic complexity improvements, but this approach has been applied systematically to only a few operations. A broader agenda of co-designing every major operation in neural networks with the memory hierarchy of target hardware could yield substantial additional gains.

**Custom hardware** for efficient architectures is a growing frontier. The success of quantized models has motivated hardware with native low-precision compute (FP8, FP4, INT4 tensor cores); the success of MoE has motivated hardware with high-bandwidth all-to-all communication; and the success of SSMs has motivated hardware with efficient scan/recurrence primitives. The interaction between architecture innovation and hardware design is bidirectional: new architectures motivate new hardware, and new hardware capabilities enable new architectures.

### Unifying Efficient Architectures

The proliferation of efficient architectures -- SSMs, linear attention, convolutions, gated RNNs, hybrids -- raises the question: is there a unified framework that encompasses these approaches? Recent theoretical work has made progress:

- **Mamba-2's SSD framework** [@dao2024transformers] showed that selective state spaces and structured masked attention are mathematically equivalent under certain conditions, unifying SSMs and attention.
- **Peng et al. (2023)** [@peng2023rwkv] showed that RWKV's WKV operation can be computed as either a parallel scan (during training) or a recurrence (during inference), unifying parallel and sequential computation.
- The connection between linear attention and recurrent networks has been established by multiple groups, showing that linear attention with appropriate feature maps is equivalent to a linear RNN.

A comprehensive theory of sequence modeling that explains when attention is necessary, when recurrence suffices, and when sub-quadratic alternatives are sufficient would be transformative for architecture design. The current empirical approach -- trying different architectures and comparing benchmark results -- is prohibitively expensive at frontier scale.

### Efficiency for Multimodal Models

As AI models increasingly process multiple modalities (text, images, video, audio), efficiency challenges multiply. Processing a single video frame as tokens can consume thousands of tokens; a 30-second video clip might require millions of tokens, exhausting the context window of current models. Efficient multimodal architectures must handle:

- **Heterogeneous token types** with different information densities (text tokens carry more semantic information per token than image patch tokens)
- **Cross-modal attention** that scales with the product of modality-specific sequence lengths
- **Modality-specific encoders** that may benefit from different architectures (CNNs for images, SSMs for audio, Transformers for text)

Current approaches (tokenizing all modalities and processing with a single Transformer) are simple but inefficient. Architectures that process different modalities with modality-appropriate methods and fuse them efficiently are an important direction.

### The 1-Bit Future

The success of BitNet b1.58 [@ma2024bitnet158] in matching full-precision model quality with ternary weights raises a provocative question: do we need floating-point computation for neural network inference at all? If ternary weights are sufficient, inference can be performed with integer additions and subtractions rather than floating-point multiplications, potentially enabling orders-of-magnitude improvements in energy efficiency and throughput on simple hardware.

The implications extend beyond inference. If future models are designed from the start for low-precision computation, the entire training pipeline, hardware architecture, and deployment infrastructure may need to be reconsidered. The path from today's FP16/BF16 training to potential 1-2 bit inference represents a fundamental shift in how neural networks are implemented.

### Test-Time Compute and Efficiency

An emerging paradigm is the tradeoff between training-time compute and test-time compute: by spending more compute at inference time (through search, verification, or chain-of-thought reasoning), models can achieve better performance than their base capabilities suggest. This creates a new efficiency question: what is the optimal allocation of a total compute budget between training and inference? Models like o1 and o3 demonstrate that spending 100x more compute at inference time can dramatically improve reasoning quality, but the economics depend on the ratio of training cost to total inference cost over the model's lifetime.
