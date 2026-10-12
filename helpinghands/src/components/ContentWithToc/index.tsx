import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

type Props = {
  children: ReactNode;
  toc?: ReactNode;
};

/**
 * A reading page's two columns: the prose, and beside it the table of contents
 * at a fixed width. Book pages (src/theme/DocItem/Layout) and blog pages
 * (src/theme/BlogLayout) both render through this, so the columns are sized in
 * one place, by this component's own classes rather than Infima's `.row` and
 * `.col`, which the theme's layered CSS can outrank.
 */
export default function ContentWithToc({children, toc}: Props): ReactNode {
  return (
    <div className={clsx(styles.columns, toc && styles.withToc)}>
      <div className={styles.prose}>{children}</div>
      {toc && <div className={styles.toc}>{toc}</div>}
    </div>
  );
}
