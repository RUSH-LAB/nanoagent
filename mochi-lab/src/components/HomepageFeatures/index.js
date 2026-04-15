import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

const FeatureList = [
  {
    title: 'Research',
    Svg: require('@site/static/img/research-svgrepo-com.svg').default,
    description: (
      <>
        Original research papers and in-depth surveys spanning continual learning,
        world models, diffusion methods, and more.
      </>
    ),
  },
  {
    title: 'Systems & Programming',
    Svg: require('@site/static/img/programming-svgrepo-com.svg').default,
    description: (
      <>
        Hands-on guides to GPU programming with CUDA and Triton, PyTorch internals,
        x86 assembly, distributed training, and ML infrastructure.
      </>
    ),
  },
  {
    title: 'Math & Theory',
    Svg: require('@site/static/img/math-svgrepo-com.svg').default,
    description: (
      <>
        Mathematical foundations for machine learning — linear algebra, optimization,
        probability, information theory, and the math behind transformers and diffusion models.
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
