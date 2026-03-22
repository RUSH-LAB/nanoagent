---
sidebar_position: 3
---

# Inference Optimization

## KV-Cache

During autoregressive generation, each new token only needs attention with all previous tokens. The **KV-cache** stores computed key and value vectors to avoid recomputation:

```python
# Without KV-cache: recompute all K,V at each step
# Step 1: compute K,V for tokens [1]             -> 1 token
# Step 2: compute K,V for tokens [1,2]           -> 2 tokens
# Step 3: compute K,V for tokens [1,2,3]         -> 3 tokens
# Total: 1+2+3+...+n = O(n^2) computation

# With KV-cache: only compute K,V for new token, append to cache
# Step 1: compute K,V for token [1], cache       -> 1 token
# Step 2: compute K,V for token [2], append       -> 1 token (attend to 2)
# Step 3: compute K,V for token [3], append       -> 1 token (attend to 3)
# Total: O(n) computation (but O(n) memory for cache)
```

KV-cache memory for a transformer:

```
Memory = 2 * num_layers * num_heads * head_dim * seq_len * bytes_per_element
For Llama 70B (80 layers, 64 heads, 128 dim, 4096 seq, BF16):
= 2 * 80 * 64 * 128 * 4096 * 2 bytes = ~10.7 GB per sequence
```

## Quantization

Reduce model size and increase throughput by using lower precision for inference:

```python
# Post-training quantization (PTQ)
import torch

# Weight-only quantization (W4A16: 4-bit weights, 16-bit activations)
model = torch.ao.quantization.quantize_dynamic(
    model,
    {torch.nn.Linear},
    dtype=torch.qint8,
)

# GPTQ (popular for LLMs)
# pip install auto-gptq
from auto_gptq import AutoGPTQForCausalLM
model = AutoGPTQForCausalLM.from_quantized("model-gptq", device="cuda:0")
```

| Method | Bits | Speed | Quality | When to use |
|--------|------|-------|---------|-------------|
| FP16/BF16 | 16 | 1x | Baseline | Default inference |
| INT8 (W8A8) | 8 | 1.5-2x | ~Baseline | Moderate savings |
| INT4 (W4A16) | 4 | 2-3x | Slight loss | Memory-constrained |
| GPTQ | 4 | 2-3x | Good | LLM deployment |
| AWQ | 4 | 2-3x | Good | LLM deployment |

## Speculative Decoding

Use a small "draft" model to generate candidate tokens, then verify them in parallel with the large model:

```
Draft model (fast):     generates k tokens: [t1, t2, t3, t4, t5]
Target model (slow):    verifies all k tokens in ONE forward pass
Accept/reject:          accept first m matching tokens, resample from m+1

Expected speedup: ~2-3x for k=5, depending on draft-target agreement
```

```python
# Conceptual implementation
def speculative_decode(draft_model, target_model, prompt, k=5):
    # 1. Draft model generates k candidate tokens
    candidates = draft_model.generate(prompt, max_new_tokens=k)

    # 2. Target model scores all k+1 positions in parallel
    target_logits = target_model(candidates)  # Single forward pass

    # 3. Accept tokens where draft matches target
    for i in range(k):
        if accept(draft_logits[i], target_logits[i]):
            # Accept this token
            continue
        else:
            # Resample from target at position i
            break
```

**Tip:** Speculative decoding gives free speedup -- it produces exactly the same distribution as the target model. The speedup depends on how well the draft model matches the target.

## vLLM

vLLM is an optimized inference engine with key innovations:

```python
from vllm import LLM, SamplingParams

llm = LLM(model="meta-llama/Llama-2-7b-hf",
           tensor_parallel_size=2)

outputs = llm.generate(
    ["Tell me about ML", "What is CUDA?"],
    SamplingParams(temperature=0.8, max_tokens=256),
)
```

Key techniques:
- **PagedAttention:** Manages KV-cache in pages (like OS virtual memory), eliminates fragmentation
- **Continuous batching:** New requests join the batch without waiting for others to finish
- **Prefix caching:** Share KV-cache across requests with common prefixes

**Tip:** For production LLM serving, always use an optimized inference engine (vLLM, TensorRT-LLM, or SGLang) rather than raw PyTorch. The speedup from KV-cache management alone is typically 2-4x.
