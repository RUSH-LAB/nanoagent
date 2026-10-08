// This plugin's page. By default it is a full-page chat with the plugin's agent. To design the
// page around what people come to do, pass mountApp a layout, `({plugin, workspace}) => Element`,
// built from ./kit/components.js and this plugin's own files (see docs/plans/plugin-ui.md).
import { mountApp } from "./kit/components.js";

mountApp();
