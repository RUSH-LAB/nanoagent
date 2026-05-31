# ML Systems

Building and deploying ML models at scale is a constant tension between compute cost, latency, and memory. This chapter covers the systems techniques that manage that tension: distributed training, mixed precision, inference optimization, and profiling.

- **[Distributed Training](./1-distributed-training.md)**: DDP, model parallelism, FSDP, DeepSpeed
- **[Mixed Precision](./2-mixed-precision.md)**: FP32/FP16/BF16/FP8, loss scaling, torch.amp
- **[Inference Optimization](./3-inference-optimization.md)**: KV-cache, quantization, speculative decoding, vLLM
- **[Profiling](./4-profiling.md)**: torch.profiler, nsys, ncu, roofline model
