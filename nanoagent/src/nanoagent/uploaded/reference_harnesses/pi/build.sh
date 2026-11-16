set -e
# The agent and its dependency tree bundle into one file, as js/pi-runner ships it: the tree is over 20,000 files.
# Some SDKs pi-ai bundles require() Node's modules, which an ES module has no require for.
NODE_PATH=/deps/node_modules node /deps/node_modules/esbuild/bin/esbuild main.mjs --bundle --minify --platform=node --format=esm --target=node22 \
  --banner:js='import{createRequire}from"node:module";const require=createRequire(import.meta.url);' --outfile=/build-out/main.mjs
