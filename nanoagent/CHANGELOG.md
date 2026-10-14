# Changelog

What each NanoAgent release changes for plugins. A plugin's `nanoagent` range in `nanoagent.yaml`
names the releases it runs on; a new minor version is one a plugin made for the last may break on.

## 0.3.0

A plugin declares `nanoagent: ~=0.3.0` and its page follows the new `ui/` rules:

- `nanoagent.yaml` names the NanoAgent versions the plugin runs on, `nanoagent`, a PEP 440 range.
- `ui/` holds `app.css` as well as `app.js`.
- `ui/app.js` exports the page's layout as its default export.
- Every script in `ui/` imports only literal `./` or `../` paths that NanoAgent serves: the kit's
  modules (`./kit/components.js`) or the plugin's own files in `ui/`.
- `ui/index.html` and `ui/kit/` are refused. NanoAgent serves its own, so a plugin deletes them.
