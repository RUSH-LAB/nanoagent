---
slug: learnable-lsh-beidi-2021
title: "Learnable LSH for Efficient Training"
authors: [zeyu]
tags: [hashing, efficient-training]
---

Paper published by Beidi Chen et al. (2021) in [ICLR](https://openreview.net/forum?id=wWK7yXkULyh).

<details>
<summary>BibTeX</summary>

```latex
@inproceedings{
chen2021mongoose,
title={{\{}MONGOOSE{\}}: A Learnable {\{}LSH{\}} Framework for Efficient Neural Network Training},
author={Beidi Chen and Zichang Liu and Binghui Peng and Zhaozhuo Xu and Jonathan Lingjie Li and Tri Dao and Zhao Song and Anshumali Shrivastava and Christopher Re},
booktitle={International Conference on Learning Representations},
year={2021},
url={https://openreview.net/forum?id=wWK7yXkULyh}
}
```
</details>

<!-- truncate -->

import Theorem, { Equation } from '@site/src/components/Math';

<Theorem id="thm:pythagorean_theorem" name="Pythagorean Theorem">
$a^2 + b^2 = c^2$ where $a$ and $b$ are the legs of a right triangle and $c$ is the hypotenuse. Pythagorean Theorem is a fundamental theorem in geometry. It is used to calculate the length of the hypotenuse of a right triangle.
</Theorem>

[](#thm:pythagorean_theorem) relates the sides of a right triangle.

<Equation id="eq:quadratic_formula">
$$
\begin{aligned}
x &= \frac{-b \pm \sqrt{b^2 - 4ac}}{2a} \\
  &= \alpha \pm \beta
\end{aligned}
$$
</Equation>

[](#eq:quadratic_formula) gives the solutions to a quadratic equation.
