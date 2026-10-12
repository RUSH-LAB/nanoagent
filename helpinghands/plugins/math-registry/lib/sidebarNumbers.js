/** Compute stable chapter/section numbers from a Docusaurus sidebar tree. */
export function computeNumbers(items, prefix = '') {
  const map = new Map();
  let counter = 0;
  for (const item of items) {
    counter++;
    const number = prefix ? `${prefix}.${counter}` : `${counter}`;
    const entry = {number, label: item.label || ''};
    if (item.type === 'link') {
      if (item.href) map.set(item.href, entry);
    } else if (item.type === 'category') {
      map.set(`category:${item.label}`, entry);
      if (item.href) map.set(item.href, entry);
      for (const [key, value] of computeNumbers(item.items || [], number)) map.set(key, value);
    }
  }
  return map;
}
