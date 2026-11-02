// The page's entry point, loaded by the kit's index.html: every plugin's page is the kit's frame
// (its Dashboard and Session tabs), drawing its outputs with the renderers in ui/renderers.js.

import renderers from "../renderers.js";
import { mountApp } from "./shell.js";

mountApp(renderers);
