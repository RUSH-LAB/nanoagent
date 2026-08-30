/**
 * Registers custom navbar item types.
 *
 * Docusaurus maps each navbar item's `type` to a component through this table.
 * Swizzling it is the supported way to add one of our own, and it is a wrapper
 * rather than a replacement: the default types are spread in, so `doc`,
 * `docSidebar`, `search` and the rest keep working.
 */
import ComponentTypes from '@theme-original/NavbarItem/ComponentTypes';
import UserButton from '@site/src/components/UserButton';

export default {
  ...ComponentTypes,
  'custom-userButton': UserButton,
};
