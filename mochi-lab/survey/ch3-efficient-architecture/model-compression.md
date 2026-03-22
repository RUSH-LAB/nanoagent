---
sidebar_position: 7
title: "Model Compression"
---

## Model Compression

Model compression reduces the size and computational requirements of trained models through distillation, pruning, and quantization.

### Knowledge Distillation

Hinton et al. (2015) [@hinton2015distilling] formalized knowledge distillation, where a smaller "student" model is trained to mimic the outputs (soft targets) of a larger "teacher" model. The soft targets carry more information than hard labels (capturing inter-class relationships), enabling the student to achieve better performance than training on labels alone. Distillation has been extensively applied to compress large language models, with DistilBERT [@sanh2019distilbert] showing that a 40% smaller BERT retains 97% of its performance.

### Pruning

Pruning removes unnecessary parameters from trained models. Unstructured pruning (zeroing individual weights) can achieve very high sparsity (90%+) with minimal accuracy loss [@han2015learning], but is difficult to accelerate on current hardware. Structured pruning (removing entire neurons, attention heads, or layers) produces models that are directly faster on standard hardware. The Lottery Ticket Hypothesis (Frankle and Carlin, 2019) [@frankle2019lottery] showed that dense networks contain sparse subnetworks ("winning tickets") that can match the full network's performance when trained in isolation.

### Quantization

Quantization reduces the numerical precision of model parameters and activations. Post-training quantization (PTQ) methods quantize a trained model without retraining:

- **GPTQ** (Frantar et al., 2023) [@frantar2023gptq]: Uses approximate second-order information to quantize LLM weights to 3-4 bits with minimal quality loss. GPTQ processes weights layer by layer, making it practical for very large models.
- **AWQ** (Lin et al., 2024) [@lin2024awq]: Activation-Aware Weight Quantization protects salient weights (those corresponding to large activations) during quantization, achieving better quality than GPTQ at the same bit-width.
- **GGML/GGUF**: A practical quantization format by Georgi Gerganov that enables LLM inference on consumer CPUs, supporting 2-8 bit quantization with various schemes. GGML has been instrumental in the consumer LLM deployment ecosystem.

Quantization-aware training (QAT) incorporates quantization effects during training, generally achieving better quality than PTQ at the same precision level [@dettmers2022gpt3int8].
