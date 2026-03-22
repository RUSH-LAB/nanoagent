import React from 'react';
import Category from '@theme-original/DocSidebarItem/Category';
import { useSidebarNumbers } from '../../SidebarNumberContext';

export default function CategoryWrapper(props) {
  const numberMap = useSidebarNumbers();
  const chapter = numberMap.get(`category:${props.item?.label}`);

  if (!chapter) {
    return <Category {...props} />;
  }

  return (
    <span style={{ '--chapter-num': `"${chapter}"` }} className="sidebar-numbered-category">
      <Category {...props} />
    </span>
  );
}
