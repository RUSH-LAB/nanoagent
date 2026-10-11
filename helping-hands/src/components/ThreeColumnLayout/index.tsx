import React, {type ComponentProps, type ReactNode} from 'react';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
import styles from './styles.module.css';

/** TwoColumnLayout whose content is a `.row` of prose and TOC columns. */
export default function ThreeColumnLayout(props: ComponentProps<typeof TwoColumnLayout>): ReactNode {
  return <TwoColumnLayout {...props} contentClassName={styles.columns} />;
}
