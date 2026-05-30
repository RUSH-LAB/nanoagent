import MDXComponents from '@theme-original/MDXComponents';
import {
  Theorem, Lemma, Proposition, Corollary,
  Definition, Remark, Example, Proof,
  Equation, Figure, Table, Code, Algorithm,
  Section, Ref, PageRef,
} from '@site/src/components/Math';
import {
  VectorPlayground, LinearTransformDemo,
  GradientDescentDemo, EigenDemo,
  RiemannSumDemo, DistributionExplorer, Surface3DDemo,
} from '@site/src/components/InteractiveMath';
import {LeanProof} from '@site/src/components/LeanProof';

export default {
  ...MDXComponents,
  Theorem, Lemma, Proposition, Corollary,
  Definition, Remark, Example, Proof,
  Equation, Figure, Table, Code, Algorithm,
  Section, Ref, PageRef,
  VectorPlayground, LinearTransformDemo,
  GradientDescentDemo, EigenDemo,
  RiemannSumDemo, DistributionExplorer, Surface3DDemo,
  LeanProof,
};
