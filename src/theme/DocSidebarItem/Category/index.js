import React from 'react';
import Category from '@theme-original/DocSidebarItem/Category';
import { useSidebarNumbers } from '@site/src/contexts/SidebarNumberContext';

export default function CategoryWrapper(props) {
  const numberMap = useSidebarNumbers();
  const entry = numberMap.get(`category:${props.item?.label}`);

  if (!entry) {
    return <Category {...props} />;
  }

  return (
    <span style={{ '--chapter-num': `"${entry.number}"` }} className="sidebar-numbered-category">
      <Category {...props} />
    </span>
  );
}
