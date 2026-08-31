import MDXComponents from '@theme-original/MDXComponents';
import pluginComponents from '@site/plugins/client-components';
import {
  VectorPlayground, LinearTransformDemo,
  GradientDescentDemo, EigenDemo,
  RiemannSumDemo, DistributionExplorer, Surface3DDemo,
} from '@site/src/components/InteractiveMath';

export default {
  ...MDXComponents,
  ...pluginComponents,
  VectorPlayground, LinearTransformDemo,
  GradientDescentDemo, EigenDemo,
  RiemannSumDemo, DistributionExplorer, Surface3DDemo,
};
