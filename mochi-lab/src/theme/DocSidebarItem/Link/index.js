import React from 'react';
import Link from '@theme-original/DocSidebarItem/Link';
import { useSidebarNumbers } from '../../SidebarNumberContext';

export default function LinkWrapper(props) {
  const numberMap = useSidebarNumbers();
  const chapter = numberMap.get(props.item?.href);

  if (!chapter) {
    return <Link {...props} />;
  }

  // Add a CSS class and custom property for the chapter number.
  // CSS ::before on .menu__link picks up --chapter-num to render inline superscript.
  const modifiedItem = {
    ...props.item,
    className: `${props.item.className || ''} sidebar-numbered-link`.trim(),
  };

  return (
    <span style={{ '--chapter-num': `"${chapter}"` }}>
      <Link {...props} item={modifiedItem} />
    </span>
  );
}
