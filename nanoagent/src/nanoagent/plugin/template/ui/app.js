// This plugin's page, shown under the Session tab once a session is open. By default it is a
// full-page chat with the plugin's agent. To design the page around what people come to do,
// export a layout instead, `({plugin, workspace, session}) => Element`, built from
// ./kit/components.js and this plugin's own files (see docs/plans/plugin-ui.md).
import { chatLayout } from "./kit/components.js";

export default chatLayout;
