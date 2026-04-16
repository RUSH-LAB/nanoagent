---
slug: compress-or-not-zeyu-2025
title: "To Compress or Not? Pushing the Frontier of Lossless GenAI Model Weights Compression with Exponent Concentration"
authors: [zeyu]
tags: [compression, lossless, genai, efficiency]
date: 2025-10-03
---

**Zeyu Yang**, Tianyi Zhang, Jianwen Xie, Chuan Li, Zhaozhuo Xu, Anshumali Shrivastava

*International Conference on Learning Representations (ICLR), 2026*

[[arXiv]](https://arxiv.org/abs/2510.02676) [[OpenReview]](https://openreview.net/forum?id=XI1CeufywD) [[Code]](https://github.com/zeyuyang8/ecf8)

<style>
.ecf8-demo-wrapper{background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:24px;font-family:'Inter',system-ui,-apple-system,sans-serif}
.ecf8-demo-header{text-align:center;margin-bottom:16px}
.ecf8-demo-subtitle{font-size:13px;color:#64748b;margin-bottom:16px}
.ecf8-demo-btn{padding:10px 28px;font-size:15px;font-weight:600;border:none;border-radius:8px;cursor:pointer;background:#3b5998;color:#fff;font-family:inherit;transition:background .2s}
.ecf8-demo-btn:hover{background:#344e85}
.ecf8-demo-btn:disabled{background:#94a3b8;cursor:not-allowed}
.ecf8-panels{display:flex;gap:16px}
.ecf8-panel{flex:1;min-width:0;border:2px solid #e2e8f0;border-radius:12px;padding:16px;background:#fafafa;transition:border-color .3s}
.ecf8-panel.done-ecf8{border-color:#16a34a}
.ecf8-panel.done-fp8{border-color:#3b5998}
.ecf8-panel-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.ecf8-panel-label{font-weight:600;font-size:15px}
.ecf8-panel-label.ecf8{color:#16a34a}
.ecf8-panel-label.fp8{color:#3b5998}
.ecf8-badge{font-size:12px;font-weight:600;color:#fff;padding:2px 8px;border-radius:12px;display:none}
.ecf8-badge.ecf8{background:#16a34a}
.ecf8-badge.fp8{background:#3b5998}
.ecf8-badge.show{display:inline-block}
.ecf8-image-box{width:100%;aspect-ratio:1;border-radius:8px;overflow:hidden;background:#f1f5f9;position:relative}
.ecf8-image-box .preview{width:100%;height:100%;object-fit:cover;filter:blur(20px) brightness(1.1);transform:scale(1.1);opacity:.5}
.ecf8-image-box .preview.hide{display:none}
.ecf8-image-box .result{width:100%;height:100%;object-fit:cover;display:none}
.ecf8-image-box .result.show{display:block}
.ecf8-spinner-wrap{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8}
.ecf8-spinner-wrap.show{display:flex}
.ecf8-spinner{width:32px;height:32px;border:3px solid #e2e8f0;border-radius:50%;animation:ecf8spin .8s linear infinite}
.ecf8-spinner.ecf8{border-top-color:#16a34a}
.ecf8-spinner.fp8{border-top-color:#3b5998}
.ecf8-spinner-text{margin-top:8px;font-size:13px}
.ecf8-progress-wrap{margin-top:12px}
.ecf8-progress-bar-bg{height:8px;border-radius:4px;background:#e2e8f0;overflow:hidden}
.ecf8-progress-bar{height:100%;border-radius:4px;width:0%;transition:width .1s linear}
.ecf8-progress-bar.ecf8{background:#16a34a}
.ecf8-progress-bar.fp8{background:#3b5998}
.ecf8-progress-info{display:flex;justify-content:space-between;font-size:13px;margin-top:4px;color:#64748b}
.ecf8-result-banner{text-align:center;margin-top:16px;padding:10px 16px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;font-size:14px;color:#15803d;display:none}
.ecf8-result-banner.show{display:block}
@keyframes ecf8spin{to{transform:rotate(360deg)}}
@media(max-width:500px){.ecf8-panels{flex-direction:column}.ecf8-demo-wrapper{padding:16px}}
</style>

<div class="ecf8-demo-wrapper">
  <div class="ecf8-demo-header">
    <p class="ecf8-demo-subtitle">Single GH200 GPU (96 GB) · DiffSynth · Playback at 4× Speed</p>
    <button class="ecf8-demo-btn" id="ecf8GenBtn" onclick="ecf8Generate()">Generate Image</button>
  </div>
  <div class="ecf8-panels">
    <div class="ecf8-panel" id="ecf8-panel-ecf8">
      <div class="ecf8-panel-header">
        <span class="ecf8-panel-label ecf8">ECF8 (Ours)</span>
        <span class="ecf8-badge ecf8" id="ecf8-badge-ecf8">13s</span>
      </div>
      <div class="ecf8-image-box">
        <img class="preview" id="ecf8-preview-ecf8" src="/img/ecf8/sample4.png" alt="" />
        <div class="ecf8-spinner-wrap" id="ecf8-spinner-ecf8"><div class="ecf8-spinner ecf8"></div><span class="ecf8-spinner-text">Generating...</span></div>
        <img class="result" id="ecf8-img-ecf8" src="/img/ecf8/sample4.png" alt="ECF8 generated" />
      </div>
      <div class="ecf8-progress-wrap">
        <div class="ecf8-progress-bar-bg"><div class="ecf8-progress-bar ecf8" id="ecf8-bar-ecf8"></div></div>
        <div class="ecf8-progress-info"><span id="ecf8-time-ecf8">0.0s / 13s</span><span id="ecf8-pct-ecf8">0%</span></div>
      </div>
    </div>
    <div class="ecf8-panel" id="ecf8-panel-fp8">
      <div class="ecf8-panel-header">
        <span class="ecf8-panel-label fp8">FP8 Baseline</span>
        <span class="ecf8-badge fp8" id="ecf8-badge-fp8">24s</span>
      </div>
      <div class="ecf8-image-box">
        <img class="preview" id="ecf8-preview-fp8" src="/img/ecf8/sample4.png" alt="" />
        <div class="ecf8-spinner-wrap" id="ecf8-spinner-fp8"><div class="ecf8-spinner fp8"></div><span class="ecf8-spinner-text">Generating...</span></div>
        <img class="result" id="ecf8-img-fp8" src="/img/ecf8/sample4.png" alt="FP8 generated" />
      </div>
      <div class="ecf8-progress-wrap">
        <div class="ecf8-progress-bar-bg"><div class="ecf8-progress-bar fp8" id="ecf8-bar-fp8"></div></div>
        <div class="ecf8-progress-info"><span id="ecf8-time-fp8">0.0s / 24s</span><span id="ecf8-pct-fp8">0%</span></div>
      </div>
    </div>
  </div>
  <div class="ecf8-result-banner" id="ecf8-result"><strong>Pixel-identical outputs.</strong> ECF8 finished in 13s, <strong>85% faster</strong> than FP8 (24s) with pixel-to-pixel identical outputs.</div>
</div>

<script>
(function(){
var T1=13,T2=24,SPD=4,raf,st,d1=false,d2=false;
function $(id){return document.getElementById('ecf8-'+id)}
function reset(){['ecf8','fp8'].forEach(function(k){$('panel-'+k).classList.remove('done-ecf8','done-fp8');$('badge-'+k).classList.remove('show');$('img-'+k).classList.remove('show');$('spinner-'+k).classList.remove('show');$('preview-'+k).classList.remove('hide');$('bar-'+k).style.width='0%';$('time-'+k).textContent='0.0s / '+(k==='ecf8'?T1:T2)+'s';$('pct-'+k).textContent='0%'});$('result').classList.remove('show');d1=d2=false}
function upd(id,tt,el){var e=Math.min(el,tt),p=Math.min(el/tt*100,100);$('bar-'+id).style.width=p+'%';$('time-'+id).textContent=e.toFixed(1)+'s / '+tt+'s';$('pct-'+id).textContent=Math.round(p)+'%';if(p>=100){$('spinner-'+id).classList.remove('show');$('img-'+id).classList.add('show');$('badge-'+id).classList.add('show');$('panel-'+id).classList.add('done-'+id);return true}return false}
function tick(){var el=(Date.now()-st)/1000*SPD;if(!d1)d1=upd('ecf8',T1,el);if(!d2)d2=upd('fp8',T2,el);if(d1&&d2){$('result').classList.add('show');document.getElementById('ecf8GenBtn').disabled=false;document.getElementById('ecf8GenBtn').textContent='Regenerate';return}raf=requestAnimationFrame(tick)}
window.ecf8Generate=function(){if(raf)cancelAnimationFrame(raf);reset();['ecf8','fp8'].forEach(function(k){$('preview-'+k).classList.add('hide');$('spinner-'+k).classList.add('show')});document.getElementById('ecf8GenBtn').disabled=true;document.getElementById('ecf8GenBtn').textContent='Generating...';st=Date.now();raf=requestAnimationFrame(tick)}
})();
</script>

Modern GenAI models are enormous. DeepSeek-R1 alone has 671 billion parameters. Even after converting to FP8, serving these models eats up massive amounts of GPU memory and bandwidth. The standard response is lossy quantization: throw away some precision and hope the outputs don't degrade too much. But what if you didn't have to lose anything at all?

In this work, we show that you can losslessly compress FP8 model weights by exploiting a simple observation about how neural networks store information. The result is **ECF8**, a format that saves up to **26.9% memory** and speeds up inference by up to **177.1%**, while producing outputs that are **bit for bit identical** to the original model.

<!-- truncate -->

## A Curious Pattern in the Bits

The starting point of this work is an empirical finding that surprised us. When we looked at the exponent bits of FP8 model weights across a wide range of architectures (LLMs, diffusion transformers, vision models), we found that these exponents are remarkably concentrated. Out of the 4 exponent bits in FP8, the Shannon entropy is typically only around **2 to 3 bits** per layer. In other words, most of the exponent values are redundant.

Here's what this looks like across 9 different models. LLMs are on the top two rows, diffusion transformers on the bottom:

![Exponent entropy across 9 models](./entropy_grid.png)

The pattern is strikingly consistent: no matter the architecture, the model size, or the modality, exponent entropy stays low. We call this **exponent concentration**.

## Why Does This Happen?

This isn't just an empirical curiosity. There's a solid explanation for it. The weights of neural networks trained with SGD are known to follow heavy tailed, $\alpha$-stable distributions. We prove that when weights come from such distributions, the entropy of the exponent field is tightly bounded. For the Gaussian case ($\alpha = 2$), the bounds fall between **1.6 and 2.67 bits**.

This analysis also gives us a theoretical compression floor: the minimum number of bits needed for a full floating point representation works out to roughly **FP4.67**. In other words, there's still significant room beyond FP8 for lossless compression, and exponent concentration is the key to unlocking it.

## How ECF8 Works

The idea behind ECF8 is straightforward. If the exponent bits have low entropy, encode them with fewer bits using Huffman coding and leave the rest untouched.

In practice, making this work efficiently on GPUs is the hard part. Our pipeline has three main components:

1. **Entropy aware encoding:** We build Huffman codes from the empirical exponent distribution of each layer, with a maximum code length of 16 bits for GPU compatibility.

2. **Hierarchical lookup tables:** For fast decoding, we use cascaded 256 entry subtables that can be traversed in parallel:

![Lookup table construction](./lookup_table.png)

3. **GPU optimized decoding kernel:** A five phase pipeline (memory init, data load, parallel counting, coordinated decode, global writeback) using 64 bit sliding windows and shared memory. Decompression happens just in time with a single preallocated buffer.

## Results

We tested ECF8 across 9 models spanning LLMs and diffusion transformers, up to 671B parameters. Here's what we found.

### Weight Compression and Throughput

| Model | Params | Memory Reduction | Throughput Gain |
|:------|:------:|:----------------:|:---------------:|
| DeepSeek-R1-0528 | 671B | 14.8% | 150.3% |
| Qwen3-235B-A22B | 235B | 14.4% | 35.9% |
| Llama-3.3-70B | 70B | 13.4% | 11.3% |
| Qwen3-Coder-30B | 30.5B | 14.3% | 23.7% |
| Qwen3-8B | 8B | 9.8% | 12.6% |
| FLUX.1-dev | 16B | 14.1% | **177.1%** |
| Wan2.1-T2V-14B | 14B | 25.4% | 55.1% |
| Wan2.2-T2V-A14B | 30B | **26.9%** | 108.3% |
| Qwen-Image | 20B | 21.0% | 126.6% |

The diffusion models benefit the most because their exponent distributions are even more concentrated, enabling higher compression ratios. FLUX.1-dev sees a nearly **3x throughput improvement**.

### LLM Inference: Latency and Batch Size

| Model | Latency Reduction | Max Batch Size |
|:------|:-----------------:|:--------------:|
| DeepSeek-R1-0528 | 60.1% | 2 → 16 |
| Qwen3-235B-A22B | 26.4% | 32 → 64 |
| Llama-3.3-70B | 10.2% | 32 → 48 |
| Qwen3-Coder-30B | 19.2% | 16 → 32 |
| Qwen3-8B | 11.2% | 16 → 24 |

On DeepSeek-R1, ECF8 cuts per request latency by **60%** and increases the maximum batch size from 2 to 16, an **8x improvement**. This is because the bottleneck for large models is memory bandwidth, and ECF8 directly reduces the amount of data that needs to move.

### Diffusion Models: End to End Speedup

| Model | E2E Latency Reduction | Memory Savings |
|:------|:---------------------:|:--------------:|
| FLUX.1-dev | 45.9% | 12.1% |
| Wan2.1-T2V-14B | 3.3% | 7.6% |
| Wan2.2-T2V-A14B | 4.0% | 17.8% |
| Qwen-Image | 55.9% | 7.9% |

Qwen-Image sees a **55.9% end to end speedup**, and every generated image is pixel identical to the uncompressed model's output.

### It's Actually Lossless

This is worth emphasizing: ECF8 is not "approximately lossless" or "nearly lossless." The outputs are **bit for bit identical**. Here are images generated by the ECF8 compressed Qwen-Image model. They match the original FP8 model down to every pixel:

| | |
|:---:|:---:|
| ![Sample 1](./sample0.png) | ![Sample 2](./sample1.png) |
| ![Sample 3](./sample2.png) | ![Sample 4](./sample3.png) |

## How This Compares to Other Approaches

**Compared to lossy quantization (GPTQ, AWQ, SqueezeLLM):** These methods trade output quality for compression. ECF8 gives you compression for free: no calibration data, no quality loss, no retraining. You can use it as a direct replacement.

**Compared to DFloat11:** DFloat11 targets BF16 weights and achieves ~30% compression. ECF8 targets the increasingly standard FP8 format and provides a theoretical framework explaining *why* compression works, rather than treating it as a purely empirical observation.

## Takeaway

The weights of trained neural networks have a hidden structure in their exponent bits, one that's universal across architectures and modalities, and that emerges naturally from the dynamics of SGD. ECF8 exploits this structure to compress FP8 weights losslessly, delivering real speedups on real models, with zero compromise on output quality.

If you're serving large models and care about exact reproducibility, give [ECF8](https://github.com/zeyuyang8/ecf8) a try.
