import React, {useState, useEffect} from 'react';
import styles from './styles.module.css';

export default function ReadingProgress() {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    function handleScroll() {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight > 0) {
        setWidth((scrollTop / docHeight) * 100);
      }
    }

    window.addEventListener('scroll', handleScroll, {passive: true});
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  if (width === 0) {
    return null;
  }

  return (
    <div
      className={styles.progressBar}
      style={{width: `${width}%`}}
    />
  );
}
