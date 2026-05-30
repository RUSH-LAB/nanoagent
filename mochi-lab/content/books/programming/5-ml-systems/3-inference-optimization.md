---
sidebar_position: 3
---

# Inference Optimization

Training a model is compute-bound: you process a fixed dataset for a fixed number of epochs, and faster GPUs directly translate to shorter training time. Inference is different. LLM inference in particular is **memory-bandwidth-bound** during autoregressive generation: each token requires reading the entire model's weights from GPU memory, but performs very few FLOPs per weight. This means inference optimization is fundamentally about reducing memory movement, not increasing compute. This chapter covers the key techniques: KV-caching, quantization, speculative decoding, and optimized serving systems.

## KV-Cache

During autoregressive generation, each new token attends to all previous tokens. Without caching, the self-attention mechanism recomputes the key and value projections for every previous token at every step, resulting in $O(n^2)$ total computation for generating $n$ tokens. The **KV-cache** stores previously computed key and value vectors:

<Code id="code-kv-cache" caption="KV-cache eliminates redundant computation during autoregressive generation.">

```python
# Without KV-cache: recompute all K,V at each step
# Step 1: Q,K,V for tokens [1]               -> 1 token of compute
# Step 2: Q,K,V for tokens [1,2]             -> 2 tokens of compute
# Step 3: Q,K,V for tokens [1,2,3]           -> 3 tokens of compute
# ...
# Step n: Q,K,V for tokens [1,...,n]          -> n tokens of compute
# Total compute: 1+2+...+n = O(n^2)

# With KV-cache: compute only the new token's Q,K,V
# Step 1: compute K1,V1 for token [1], cache  -> 1 token of compute
# Step 2: compute K2,V2 for token [2], append  -> 1 token (attend to cache of 2)
# Step 3: compute K3,V3 for token [3], append  -> 1 token (attend to cache of 3)
# ...
# Step n: compute Kn,Vn for token [n], append  -> 1 token (attend to cache of n)
# Total compute: O(n)
# Total memory: O(n) for the cached K,V tensors
```

</Code>

<Table id="tab-kv-cache-memory" caption="KV-cache memory for popular LLM architectures (BF16, full context).">

| Model | Layers | KV Heads | Head Dim | Max Seq Len | KV-Cache per Seq | KV-Cache at Full Batch |
|-------|--------|----------|----------|-------------|-----------------|----------------------|
| Llama 2 7B | 32 | 32 | 128 | 4,096 | 2 GB | 2 GB $\times$ batch |
| Llama 2 70B | 80 | 8 (GQA) | 128 | 4,096 | 1.3 GB | 1.3 GB $\times$ batch |
| Llama 3 8B | 32 | 8 (GQA) | 128 | 128,000 | 16 GB | Dominates memory |
| GPT-4 (est.) | 120 | ? (MQA/GQA) | 128 | 128,000 | 10+ GB | Enormous |

</Table>

The formula for KV-cache memory:

$$
\text{KV memory} = 2 \times L \times n_{\text{kv\_heads}} \times d_{\text{head}} \times s \times b_{\text{dtype}}
$$

where $L$ = layers, $n_{\text{kv\_heads}}$ = number of key/value heads (reduced by GQA/MQA), $d_{\text{head}}$ = head dimension, $s$ = sequence length, and $b_{\text{dtype}}$ = bytes per element.

<Remark id="rmk-gqa-mqa">
**GQA and MQA reduce KV-cache size.** Multi-Query Attention (MQA) uses 1 KV head shared across all query heads, reducing KV-cache by the number of query heads (e.g., 32x for 32-head model). Grouped-Query Attention (GQA) is a compromise: groups of query heads share KV heads (e.g., 8 KV heads for 32 query heads = 4x reduction). Llama 2 70B uses GQA with 8 KV heads, reducing its KV-cache by 8x compared to full multi-head attention.
</Remark>

## Two Phases of LLM Inference

LLM inference has two distinct phases with very different compute characteristics:

<Table id="tab-prefill-vs-decode" caption="Prefill vs decode: the two phases of LLM inference.">

| Property | Prefill Phase | Decode Phase |
|----------|-------------|--------------|
| What happens | Process entire prompt at once | Generate tokens one at a time |
| Batch dimension | Large (prompt length) | 1 token per sequence |
| Compute pattern | Large matrix multiply | Small matrix-vector multiply |
| Bottleneck | Compute-bound (Tensor Cores) | Memory-bandwidth-bound (weight loading) |
| GPU utilization | High (80-100%) | Low (5-20%) |
| Arithmetic intensity | High | Very low (~1 FLOP/byte for weight read) |
| Optimization | Standard matmul optimization | Batching, quantization, speculation |

</Table>

<Remark id="rmk-decode-bottleneck">
**Why decode is memory-bound.** During decode, each token generation reads the entire model's weight matrices but performs only a matrix-vector multiply (batch size 1). For a 7B parameter model in BF16: reading 14 GB of weights at H100 bandwidth (3.35 TB/s) takes ~4.2 ms, but the actual computation (14B FLOPs at 990 TFLOPS) takes only ~0.014 ms. The GPU spends 99.7% of its time waiting for memory. This is why **batching** multiple sequences together is crucial: it amortizes the weight-reading cost across multiple sequences.
</Remark>

## Quantization

Quantization reduces model size and memory bandwidth requirements by representing weights (and sometimes activations) in lower precision. The methods below range from 8-bit post-training schemes to extreme 1.58-bit quantization-aware training (BitNet b1.58 [@ma2024bitnet158]):

<Table id="tab-quantization-methods" caption="Quantization methods for LLM inference, from least to most aggressive.">

| Method | Weight Bits | Activation Bits | Model Size (7B) | Quality Impact | Speed vs FP16 |
|--------|------------|----------------|-----------------|---------------|---------------|
| FP16/BF16 | 16 | 16 | 14 GB | Baseline | 1x |
| SmoothQuant (W8A8) | 8 | 8 | 7 GB | Negligible | 1.5-2x |
| GPTQ (W4A16) | 4 | 16 | 3.5 GB | Small | 2-3x |
| AWQ (W4A16) | 4 | 16 | 3.5 GB | Small | 2-3x |
| GGUF Q4_K_M | 4-6 mixed | 16 | ~4 GB | Small | 2-3x (CPU) |
| GPTQ (W3A16) | 3 | 16 | 2.6 GB | Moderate | 3-4x |
| BitNet (W1.58) | 1.58 | 8 | ~1.5 GB | Requires training | 4-8x (theoretical) |

</Table>

<Code id="code-quantization" caption="Using quantized models with popular libraries.">

```python
# ── GPTQ: post-training quantization ──
from auto_gptq import AutoGPTQForCausalLM
model = AutoGPTQForCausalLM.from_quantized(
    "TheBloke/Llama-2-7B-GPTQ",
    device="cuda:0",
    use_triton=True,  # Use Triton kernels for dequant
)

# ── AWQ: activation-aware quantization ──
from awq import AutoAWQForCausalLM
model = AutoAWQForCausalLM.from_quantized(
    "TheBloke/Llama-2-7B-AWQ",
    fuse_layers=True,  # Fuse dequant with matmul
)

# ── bitsandbytes: simple quantization API ──
import bitsandbytes as bnb
from transformers import AutoModelForCausalLM

model = AutoModelForCausalLM.from_pretrained(
    "meta-llama/Llama-2-7b-hf",
    load_in_4bit=True,
    bnb_4bit_compute_dtype=torch.bfloat16,  # Compute in BF16
    bnb_4bit_quant_type="nf4",              # NormalFloat4 quantization
)

# ── PyTorch native quantization ──
model = torch.ao.quantization.quantize_dynamic(
    model, {torch.nn.Linear}, dtype=torch.qint8,
)
```

</Code>

<Remark id="rmk-quantization-quality">
**How quantization affects quality.** Weight-only quantization (W4A16, W8A16) has minimal quality impact because activations remain in full precision. The key insight from GPTQ [@frantar2023gptq] and AWQ [@lin2024awq] is that not all weights are equally important: a small fraction of weights (tied to large activation magnitudes) contribute disproportionately to output quality. Both methods identify and preserve these important weights, quantizing the rest more aggressively. At 4-bit, typical perplexity degradation is 0.1-0.5 points on language modeling benchmarks.
</Remark>

## Speculative Decoding

Speculative decoding [@leviathan2023fast; @chen2023accelerating] uses a small, fast **draft model** to generate candidate tokens, then verifies them in parallel with the large **target model**. When the draft model's predictions agree with the target model, multiple tokens are accepted per forward pass of the target model:

<Code id="code-speculative-decoding" caption="Speculative decoding: generate candidates fast, verify in parallel.">

```python
def speculative_decode(draft_model, target_model, tokens, k=5):
    """Generate tokens with speculative decoding.

    Produces EXACTLY the same distribution as sampling from target_model alone.
    Speedup comes from accepting multiple draft tokens per target forward pass.
    """
    while not done:
        # 1. Draft model generates k candidate tokens autoregressively (fast)
        draft_tokens = []
        draft_probs = []
        for _ in range(k):
            p = draft_model(tokens + draft_tokens)
            t = sample(p)
            draft_tokens.append(t)
            draft_probs.append(p)

        # 2. Target model scores all k draft positions in ONE forward pass.
        #    Feeding tokens + draft_tokens also yields the distribution at the
        #    final position, used to sample a free bonus token if all k accept.
        all_tokens = tokens + draft_tokens
        target_probs = target_model(all_tokens)  # k draft dists + 1 bonus dist

        # 3. Accept/reject each draft token
        accepted_all = True
        for i in range(k):
            # Accept with probability min(1, target_prob / draft_prob)
            r = random.random()
            if r < min(1, target_probs[i][draft_tokens[i]] /
                         draft_probs[i][draft_tokens[i]]):
                tokens.append(draft_tokens[i])  # Accept
            else:
                # Reject: sample from adjusted distribution
                tokens.append(sample(adjusted_distribution))
                accepted_all = False
                break  # Stop accepting, start new draft round

        # 4. If all k drafts accepted, sample the free bonus token from the
        #    target distribution at the final position (the source of speedup).
        if accepted_all:
            tokens.append(sample(target_probs[k]))

    return tokens
```

</Code>

<Table id="tab-speculative-decoding" caption="Speculative decoding speedup depends on draft-target agreement.">

| Draft Model | Target Model | Acceptance Rate | Speedup | Notes |
|------------|-------------|----------------|---------|-------|
| Llama 2 7B | Llama 2 70B | ~70% | 2-2.5x | Same family, good agreement |
| Llama 68M | Llama 2 7B | ~50% | 1.5-2x | Small draft, moderate agreement |
| n-gram model | Any | ~30-50% | 1.3-1.8x | No GPU needed for draft |
| Self-draft (early exit) | Full model | ~60% | 1.5-2x | Single model, no separate draft |

</Table>

<Remark id="rmk-spec-decode-exact">
**Speculative decoding is exact.** The acceptance/rejection scheme is designed so that the marginal distribution of each generated token is exactly the same as sampling from the target model alone. This is not an approximation: it is a mathematically guaranteed property [@leviathan2023fast; @chen2023accelerating]. The speedup is "free" in terms of output quality.
</Remark>

## Optimized Serving Systems

For production LLM serving, specialized inference engines provide 3-10x higher throughput than raw PyTorch. Two techniques are foundational: PagedAttention [@kwon2023efficient], which manages the KV-cache like OS virtual memory, and FlashAttention [@dao2022flashattention], a fused, IO-aware attention kernel.

<Code id="code-vllm" caption="vLLM: high-throughput LLM serving with PagedAttention.">

```python
from vllm import LLM, SamplingParams

llm = LLM(
    model="meta-llama/Llama-2-7b-hf",
    tensor_parallel_size=2,        # Split across 2 GPUs
    quantization="awq",            # Use quantized model
    max_model_len=4096,
    gpu_memory_utilization=0.90,   # Use 90% of GPU memory for KV-cache
)

outputs = llm.generate(
    ["Tell me about ML", "What is CUDA?"],
    SamplingParams(temperature=0.8, top_p=0.95, max_tokens=256),
)
```

</Code>

<Table id="tab-serving-systems" caption="Key techniques in optimized LLM serving systems.">

| Technique | What It Does | Why It Helps | Used By |
|-----------|-------------|-------------|---------|
| PagedAttention | Manages KV-cache in non-contiguous pages (like OS virtual memory) | Eliminates memory fragmentation; ~2x more sequences fit | vLLM |
| Continuous batching | New requests join the running batch immediately | No waiting for batch to finish; higher GPU utilization | vLLM, TRT-LLM |
| Prefix caching | Share KV-cache across requests with identical prefixes | System prompts computed once, reused for all requests | vLLM, SGLang |
| FlashAttention | Fused attention kernel, tiled for SRAM | 2-4x faster attention, O(1) extra memory | All modern engines |
| FlashDecoding | Parallel KV-cache reduction across heads | Faster decode with long contexts | TRT-LLM |
| CUDA Graphs | Capture and replay kernel launch sequences | Eliminates CPU launch overhead per token | TRT-LLM, vLLM |
| Weight-only quantization | 4-bit weights with FP16 compute | 3-4x less memory, higher batch size | All engines |

</Table>

<Remark id="rmk-serving-choice">
**Choosing a serving engine.** For most LLM serving needs:
- **vLLM**: Best default choice. Excellent throughput, active development, easy API, broad model support.
- **TensorRT-LLM**: Maximum single-request latency optimization, requires NVIDIA compilation step, less flexible.
- **SGLang**: Best for structured generation (JSON, regex constraints), RadixAttention for shared prefixes.
- **llama.cpp**: Best for CPU inference and edge deployment, quantization-focused.

Always benchmark on your specific workload: optimal throughput depends on request length distribution, batch size, and hardware.
</Remark>

<Remark id="rmk-continuous-batching">
**Continuous batching vs static batching.** Static batching waits until a fixed batch of requests is assembled, processes them all to completion, and then starts the next batch. If one request in the batch generates 500 tokens and another generates 10, the GPU sits idle after the short request finishes. Continuous batching (also called iteration-level batching) solves this:

```
Static batching:
  Batch 1: [req A (500 tok), req B (10 tok)] → GPU idle after B finishes at step 10
            Steps 11-500: only req A is running, GPU underutilized

Continuous batching:
  Step 1-10:   [req A, req B] both running
  Step 11:     req B finishes → req C joins immediately
  Step 11-100: [req A, req C] both running
  Step 101:    req C finishes → req D joins
  ...
  GPU always has a full batch; no idle slots
```

The result: 2-5x higher throughput under real-world request distributions where output lengths vary significantly. All modern serving engines (vLLM, TRT-LLM, SGLang) implement continuous batching.
</Remark>

## Inference Optimization Checklist

<Table id="tab-inference-checklist" caption="Inference optimization techniques in priority order.">

| Priority | Technique | Memory Saving | Speed Improvement | Effort |
|----------|----------|--------------|------------------|--------|
| 1 | Use an optimized serving engine (vLLM, TRT-LLM) | Moderate (PagedAttention) | 3-10x | Low (just deploy) |
| 2 | Enable KV-cache | None (trades memory for compute) | 10-100x | Built-in |
| 3 | Quantize to INT8 or INT4 | 2-4x | 1.5-3x | Low |
| 4 | Increase batch size | None | 2-8x (better GPU util) | Low |
| 5 | Use FlashAttention | Reduces activation memory | 2-4x for attention | Low (drop-in) |
| 6 | Speculative decoding | None | 1.5-2.5x | Medium |
| 7 | Tensor parallelism (multi-GPU) | Splits model | Near-linear | Medium |
| 8 | Prefix caching | Shared KV-cache | Depends on workload | Low (config) |
| 9 | torch.compile / CUDA Graphs | None | 1.1-1.5x | Low |

</Table>
