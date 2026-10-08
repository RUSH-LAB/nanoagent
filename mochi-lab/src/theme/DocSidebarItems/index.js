import React, { memo, useMemo } from 'react';
import DocSidebarItems from '@theme-original/DocSidebarItems';
import SidebarNumberContext, { computeNumbers } from '@site/src/contexts/SidebarNumberContext';

function DocSidebarItemsWrapper({ items, level, ...props }) {
  // Only compute numbering at the top level (level === 1) to avoid
  // re-computing for nested lists. The context propagates down.
  const numberMap = useMemo(() => {
    if (level === 1) {
      return computeNumbers(items);
    }
    return null;
  }, [items, level]);

  if (numberMap) {
    return (
      <SidebarNumberContext.Provider value={numberMap}>
        <DocSidebarItems items={items} level={level} {...props} />
      </SidebarNumberContext.Provider>
    );
  }

  return <DocSidebarItems items={items} level={level} {...props} />;
}

export default memo(DocSidebarItemsWrapper);
