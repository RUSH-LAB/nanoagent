import React from 'react';
import Link from '@theme-original/DocSidebarItem/Link';
import { useSidebarNumbers } from '@site/src/contexts/SidebarNumberContext';

export default function LinkWrapper(props) {
  const numberMap = useSidebarNumbers();
  const entry = numberMap.get(props.item?.href);

  if (!entry || props.level > 1) {
    return <Link {...props} />;
  }

  // Add a CSS class and custom property for the inline chapter-number column.
  const modifiedItem = {
    ...props.item,
    className: `${props.item.className || ''} sidebar-numbered-link`.trim(),
  };

  return (
    <span style={{ '--chapter-num': `"${entry.number}"` }}>
      <Link {...props} item={modifiedItem} />
    </span>
  );
}
