set -e
cp main.mjs /build-out/main.mjs
# Platform binaries ship for linux x64 and arm64; the build image's own architecture is the only one the run needs.
# Type declarations and source maps are not loaded at run time; the tree is large enough to matter for the build output's limits.
case "$(node -p process.arch)" in arm64) other=x64 ;; *) other=arm64 ;; esac
tar -C /deps --exclude="*linux-$other*" --exclude='*.d.ts' --exclude='*.d.cts' --exclude='*.d.mts' --exclude='*.map' -cf - node_modules | tar -C /build-out -xf -
