set -e
# The agent and its dependency tree bundle into one file, as js/pi-runner ships it: the tree is over 20,000 files.
# Some SDKs pi-ai bundles require() Node's modules, which an ES module has no require for.
NODE_PATH=/deps/node_modules node /deps/node_modules/esbuild/bin/esbuild main.mjs --bundle --minify --platform=node --format=esm --target=node22 \
  --banner:js='import{createRequire}from"node:module";const require=createRequire(import.meta.url);' --outfile=/build-out/main.mjs
# The interactive screen is the `pi` CLI, run from its package: the build image's own architecture's native packages only, no type
# declarations or source maps.
case "$(node -p process.arch)" in arm64) other=x64 ;; *) other=arm64 ;; esac
tar -C /deps --exclude="*linux-$other*" --exclude='*.d.ts' --exclude='*.d.cts' --exclude='*.d.mts' --exclude='*.map' -cf - node_modules | tar -C /build-out -xf -
