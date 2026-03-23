---
sidebar_position: 8
title: "Fourier & Spectral Perspectives"
---

# Fourier & Spectral Perspectives

### Fourier Features for Neural Networks

Tancik et al. (2020) [@tancik2020fourier] demonstrated that standard neural networks fail to learn high-frequency functions from low-dimensional inputs due to a spectral bias toward low frequencies (the "frequency bias" or "spectral bias") [@rahaman2019spectral]. Their solution -- mapping inputs through random Fourier features before feeding them to the network -- enables learning of high-frequency content. This was transformative for Neural Radiance Fields (NeRF) [@mildenhall2020nerf] and other coordinate-based neural representations, where fine geometric and appearance details require high-frequency function approximation.

The connection to random features (Section 5.4.2) is direct: Fourier feature mappings are instances of random feature maps for the RBF kernel, and the frequency distribution of the random features controls the bandwidth of learnable functions [@tancik2020fourier].

### Spectral Analysis of Attention

Self-attention can be analyzed through a spectral lens. The attention matrix, when viewed as a linear operator, has a spectrum that reveals the information flow patterns in the network [@bhojanapalli2020low]. Empirical analysis consistently shows that trained attention matrices are approximately low-rank -- a few principal components capture most of the variance -- which explains why low-rank attention approximations (Linformer [@wang2020linformer]) work well in practice. The connection between attention and kernel methods [@tsai2019transformer] enables the use of random feature approximations for attention (e.g., Performer [@choromanski2021rethinking]), linking back to Rahimi and Recht's work. The spectrum of the attention matrix also reveals information about the learned representations: attention heads with concentrated spectra act as "sharp" selectors (focusing on specific tokens), while those with flat spectra act as "smooth" aggregators (mixing information broadly).

### Frequency Bias in Neural Networks

Rahaman et al. (2019) [@rahaman2019spectral] showed that neural networks learn low-frequency components of target functions before high-frequency components -- a phenomenon they called the "spectral bias" or F-principle. Concretely, for a target function with Fourier decomposition f = sum_k a_k * exp(ikx), neural networks first learn the components with small |k| (low frequency) and gradually acquire higher-frequency components during training. This has important implications for architecture design: networks struggle with high-frequency patterns unless explicitly encouraged (via positional encoding, Fourier features, or architectural modifications). The Neural Tangent Kernel (NTK) framework [@jacot2018neural] provides a theoretical explanation: the NTK has a spectrum that decays with frequency, causing low-frequency components to converge faster during gradient descent. Understanding spectral bias helps explain why certain architectures (e.g., those with skip connections or Fourier-based layers) generalize better -- they can capture the full frequency spectrum of the target function more evenly.

### FNet

Lee-Thorp et al. (2022) [@leethorp2022fnet] proposed FNet, which replaces the self-attention sublayer in Transformers with a simple Fourier transform (unparameterized 2D DFT over the sequence and hidden dimensions). FNet achieves 92% of BERT's accuracy on GLUE while training 80% faster on GPUs and 70% faster on TPUs. This striking result suggests that much of what attention does can be approximated by fixed spectral mixing operations, connecting Transformer architecture to classical signal processing.

### Adaptive Fourier Neural Operators

Guibas et al. (2022) [@guibas2022adaptive] proposed AFNO (Adaptive Fourier Neural Operator), which uses parameterized Fourier transforms as token mixing operations in Transformers. Unlike FNet's fixed FFT, AFNO learns channel-mixing weights in the frequency domain, combining the efficiency of spectral methods with the expressiveness of learned parameters. The architecture applies a 2D FFT to the input tokens, applies learned complex-valued weights in the frequency domain (equivalent to a pointwise multiplication that implements global convolution), and applies an inverse FFT to return to the spatial domain. AFNO has been applied to weather forecasting (FourCastNet [@pathak2022fourcastnet] achieves comparable accuracy to the European Centre HRES model at 45,000x speedup), climate modeling, and other scientific computing tasks where the natural frequency-domain structure of the data provides a strong inductive bias.

The broader family of Fourier Neural Operators (FNO) [@li2021fourier] extends this approach to learning solution operators for partial differential equations. FNO parameterizes the integral kernel in Fourier space, learning the Green's function of the PDE in a data-driven manner. This is a deep connection to classical applied mathematics: the Green's function, which maps boundary conditions and forcing functions to solutions, is traditionally computed analytically (when possible) or numerically. FNO learns it from data, inheriting the spectral efficiency of Fourier methods (smooth kernels have sparse Fourier representations) while avoiding the need for analytical derivations. FNO achieves 1000x speedup over traditional numerical solvers for Navier-Stokes equations at a resolution of 256x256.

### Fourier Analysis of Generalization

The spectral perspective provides a principled framework for understanding generalization in deep learning. The key observation is that target functions in real-world tasks typically have most of their energy in low-frequency components -- natural images have power spectra that decay as 1/f^2, text has long-range correlations captured by low-frequency modes, and physical dynamics are governed by smooth (low-frequency) laws. The spectral bias of neural networks [@rahaman2019spectral] means they naturally learn these dominant low-frequency components first, which explains why early stopping (stopping training before the network has learned the high-frequency noise) improves generalization. From a regularization perspective, the spectral bias acts as an implicit frequency-dependent regularizer: low-frequency components are learned quickly (low regularization), while high-frequency components are learned slowly (high regularization), matching the statistical structure of natural data where low-frequency components are signal and high-frequency components are often noise.
