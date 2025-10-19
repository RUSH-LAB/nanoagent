import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

const FeatureList = [
  {
    title: 'CUDA',
    Svg: require('@site/static/img/cuda-svgrepo-com.svg').default,
    description: (
      <>
        CUDA is a parallel computing platform and API developed by NVIDIA, which allows developers to use GPUs for general-purpose computing.
      </>
    ),
  },
  {
    title: 'PyTorch',
    Svg: require('@site/static/img/pytorch-svgrepo-com.svg').default,
    description: (
      <>
        PyTorch is an open-source machine learning framework, primarily used for developing and training deep neural networks.
      </>
    ),
  },
  {
    title: 'Assembly',
    Svg: require('@site/static/img/assembly-svgrepo-com.svg').default,
    description: (
      <>
        Assembly is a low-level programming language that provides a human-readable representation of machine code. 
      </>
    ),
  },
];

function Feature({Svg, title, description}) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center">
        <Svg className={styles.featureSvg} role="img" />
      </div>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
