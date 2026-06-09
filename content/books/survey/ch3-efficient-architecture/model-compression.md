---
sidebar_position: 7
title: "Model Compression"
---

## Model Compression

Model compression reduces the size and computational requirements of trained models through distillation, pruning, and quantization. These techniques are essential for deploying large models on resource-constrained hardware (mobile, edge, consumer GPUs) and for reducing the serving cost of large-scale deployments.

### Knowledge Distillation

Hinton et al. (2015) [@hinton2015distilling] formalized knowledge distillation, where a smaller "student" model is trained to mimic the outputs (soft targets) of a larger "teacher" model. The soft targets (softmax outputs with temperature scaling) carry richer information than hard labels: they encode the teacher's uncertainty and inter-class relationships. A student trained to match the teacher's soft targets learns not just "what the answer is" but "how confident the teacher is" and "what other answers are plausible," resulting in better generalization than training on hard labels alone.

Distillation has been extensively applied to compress large language models. **DistilBERT** [@sanh2019distilbert] showed that a 40% smaller BERT (6 layers vs. 12) retains 97% of BERT's performance on GLUE when trained with distillation. For LLMs, distillation has been used to create smaller models that approximate frontier model behavior: models like Alpaca, Vicuna, and Phi were partly trained using outputs from larger models, a practice sometimes called "model distillation" in the LLM context (though distinct from Hinton's original formulation).

### Pruning

Pruning removes unnecessary parameters from trained models, exploiting the observation that most neural networks are heavily over-parameterized. **Unstructured pruning** (zeroing individual weights based on magnitude or other criteria) can achieve very high sparsity (90%+) with minimal accuracy loss [@han2015learning], but is difficult to accelerate on current GPU hardware which is optimized for dense computation. **Structured pruning** (removing entire neurons, attention heads, or layers) produces models that are directly faster on standard hardware, but achieves lower sparsity levels before quality degrades.

The **Lottery Ticket Hypothesis** (Frankle and Carbin, 2019) [@frankle2019lottery] provided a theoretical perspective: dense networks contain sparse subnetworks ("winning tickets") that, when trained in isolation from the same initialization, can match the full network's performance. This suggests that the role of over-parameterization is not to provide more capacity but to provide more chances of containing a good subnetwork. Finding these winning tickets efficiently (without training the full network first) remains an active research challenge.

For LLMs, **SparseGPT** (Frantar and Alistarh, 2023) [@frantar2023sparsegpt] demonstrated that LLMs can be pruned to 50-60% sparsity in a single pass (without retraining) by solving a layer-wise reconstruction problem, analogous to GPTQ for quantization. Wanda (Sun et al., 2024) [@sun2024wanda] proposed an even simpler pruning criterion based on the product of weight magnitude and input activation norm, achieving comparable sparsity with lower computational cost. In practice, the tradeoff is clear: unstructured pruning reaches higher sparsity before quality degrades, but requires specialized hardware to realize speedups, while structured pruning produces immediate gains on commodity GPUs at the cost of lower maximum sparsity.

### Quantization

Quantization reduces the numerical precision of model parameters and activations, replacing FP16/BF16 values (16 bits) with lower-precision representations (8, 4, 3, or even 1-2 bits).

**Post-training quantization (PTQ)** methods quantize a trained model without retraining:

- **LLM.int8()** (Dettmers et al., 2022) [@dettmers2022gpt3int8]: Demonstrated that LLMs can be quantized to 8-bit integers (INT8) with almost no quality loss by handling outlier features separately. Key insight: a small fraction of hidden dimensions have very large activation values ("outliers") that cause problems for naive quantization. LLM.int8() identifies these outlier dimensions and keeps them in FP16 while quantizing the rest to INT8.
- **GPTQ** (Frantar et al., 2023) [@frantar2023gptq]: Uses approximate second-order information (Hessian-based optimization) to quantize LLM weights to 3-4 bits with minimal quality loss. GPTQ processes weights layer by layer, making it practical for models up to hundreds of billions of parameters. At 4-bit, GPTQ achieves nearly lossless compression for larger LLMs (7B+ parameters) on standard benchmarks, though quality degradation increases on smaller models and harder reasoning tasks.
- **AWQ** (Lin et al., 2024) [@lin2024awq]: Activation-Aware Weight Quantization identifies salient weights (those corresponding to large activations in a calibration set) and protects them during quantization, achieving better quality than GPTQ at the same bit-width. AWQ's key insight is that weight importance should be measured by the scale of corresponding activations, not the weight magnitude itself.
- **GGML/GGUF**: A practical quantization ecosystem by Georgi Gerganov that enables LLM inference on consumer CPUs, supporting 2-8 bit quantization with various schemes (Q4_0, Q4_K_M, Q5_K_M, etc.). GGML/GGUF has been instrumental in the consumer LLM deployment ecosystem, enabling models like Llama and Mistral to run on laptops and desktops.

**Quantization-aware training (QAT)** incorporates quantization effects during training, simulating low-precision arithmetic in the forward pass while maintaining full-precision gradients. QAT generally achieves better quality than PTQ at the same precision level because the model learns to be robust to quantization noise [@dettmers2022gpt3int8]. The landscape thus forms a Pareto frontier: post-training methods (GPTQ, AWQ, GGML) offer zero-retraining deployment at the cost of some accuracy loss, QAT trades training cost for higher quality at the same bit width, and lossless formats (covered below) sit at the conservative end, giving up the largest size reductions in exchange for exact preservation of model outputs.

### Ultra-Low Precision: 1-Bit and Ternary Models

A frontier area of quantization research pushes precision to its extreme limits:

**BitNet** (Wang et al., 2023) [@wang2023bitnet] introduced 1-bit weight quantization for transformers, where weights are constrained to {-1, +1}. BitNet replaces standard linear projections with binary operations (sign function), dramatically reducing both memory and computation (binary operations replace floating-point multiplications). While BitNet requires training from scratch (rather than post-training quantization), it demonstrates that the transformer architecture can function with extreme weight compression.

**BitNet b1.58** (Ma et al., 2024) [@ma2024bitnet158] extended BitNet to ternary weights {-1, 0, +1}, where the "1.58 bits" refers to log2(3). This small extension from binary to ternary makes a surprisingly large difference in model quality, because zero-valued weights enable explicit feature selection (the model can choose to ignore certain dimensions). BitNet b1.58 matches full-precision Llama at equivalent model sizes while being dramatically more efficient. The paper's energy model estimates a theoretical 71.4x reduction in arithmetic energy for matrix multiplication at the 7nm node (an arithmetic-only figure; realized end-to-end and real-CPU gains are far smaller, roughly 2-5x on commodity hardware). Weight memory drops more modestly, by roughly 10x relative to a full-precision 16-bit model (1.58 bits vs. 16 bits per weight). This result suggests that the future of LLM inference may involve ternary or binary computation on specialized hardware.

### DFloat11: Lossless Compression

Zhang et al. (2025) [@zhang2025dfloat11] proposed DFloat11, a lossless compression format that exploits the statistical structure of BF16 model weights. By observing that LLM weights follow a near-Gaussian distribution with predictable bit patterns, DFloat11 achieves approximately 30% compression with zero quality loss, unlike lossy quantization methods which always involve some accuracy tradeoff. DFloat11 demonstrates that even without accepting any quality loss, significant memory savings are possible through intelligent encoding.
