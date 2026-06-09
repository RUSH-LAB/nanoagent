import React from 'react';
import styles from './styles.module.css';

/**
 * Reusable loading skeleton component.
 *
 * @param {Object} props
 * @param {"text"|"block"|"circle"} [props.shape="text"] - Skeleton shape
 * @param {string|number} [props.width]  - CSS width  (e.g. "100%", 200)
 * @param {string|number} [props.height] - CSS height (e.g. "1em", 40)
 * @param {Object} [props.style] - Additional inline styles
 */
export default function LoadingSkeleton({
  shape = 'text',
  width,
  height,
  style,
}) {
  const shapeClass =
    shape === 'block'
      ? styles.block
      : shape === 'circle'
        ? styles.circle
        : styles.text;

  return (
    <div
      className={shapeClass}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        ...style,
      }}
    />
  );
}
