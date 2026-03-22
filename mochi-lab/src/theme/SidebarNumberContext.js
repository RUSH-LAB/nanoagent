import { createContext, useContext } from 'react';

// Maps item key (href or label) → chapter number string ("1", "2.1", "2.1.3", ...)
const SidebarNumberContext = createContext(new Map());

/**
 * Recursively compute chapter numbers from a sidebar items tree.
 * Top-level items: 1, 2, 3, ...
 * Children of item 2: 2.1, 2.2, ...
 * Children of 2.1: 2.1.1, 2.1.2, ...
 */
export function computeNumbers(items, prefix = '') {
  const map = new Map();
  let counter = 0;

  for (const item of items) {
    counter++;
    const num = prefix ? `${prefix}.${counter}` : `${counter}`;

    if (item.type === 'link') {
      if (item.href) map.set(item.href, num);
    } else if (item.type === 'category') {
      // Key categories by label (they may or may not have href)
      map.set(`category:${item.label}`, num);
      if (item.href) map.set(item.href, num);
      // Recurse into children
      const childMap = computeNumbers(item.items || [], num);
      for (const [k, v] of childMap) map.set(k, v);
    }
  }

  return map;
}

export function useSidebarNumbers() {
  return useContext(SidebarNumberContext);
}

export default SidebarNumberContext;
