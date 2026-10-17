/**
 * Registers custom navbar item types.
 *
 * Docusaurus maps each navbar item's `type` to a component through this table.
 * Swizzling it is the supported way to add one of our own, and it is a wrapper
 * rather than a replacement: the default types are spread in, so `doc`,
 * `docSidebar`, `search` and the rest keep working. Given `mobile`, a type
 * renders its entries in the narrow window's menu as `li.menu__list-item`s, as
 * the default types do, so they are spaced as the others are.
 */
import DefaultNavbarItem from '@theme/NavbarItem/DefaultNavbarItem';
import DropdownNavbarItem from '@theme/NavbarItem/DropdownNavbarItem';
import LocaleDropdownNavbarItem from '@theme/NavbarItem/LocaleDropdownNavbarItem';
import HtmlNavbarItem from '@theme/NavbarItem/HtmlNavbarItem';
import DocNavbarItem from '@theme/NavbarItem/DocNavbarItem';
import DocSidebarNavbarItem from '@theme/NavbarItem/DocSidebarNavbarItem';
import DocsVersionNavbarItem from '@theme/NavbarItem/DocsVersionNavbarItem';
import DocsVersionDropdownNavbarItem from '@theme/NavbarItem/DocsVersionDropdownNavbarItem';
import UserButton from '@site/src/components/UserButton';
import SearchTrigger from '@site/src/components/SearchTrigger';

export default {
  default: DefaultNavbarItem,
  localeDropdown: LocaleDropdownNavbarItem,
  search: SearchTrigger,
  dropdown: DropdownNavbarItem,
  html: HtmlNavbarItem,
  doc: DocNavbarItem,
  docSidebar: DocSidebarNavbarItem,
  docsVersion: DocsVersionNavbarItem,
  docsVersionDropdown: DocsVersionDropdownNavbarItem,
  'custom-userButton': UserButton,
};
