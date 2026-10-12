// The page's entry point, loaded by the kit's index.html: every plugin page runs inside the
// kit's frame (its Dashboard and Session tabs). app.js exports the page as its default export.

import layout from "../app.js";
import { mountApp } from "./shell.js";

mountApp(layout);
