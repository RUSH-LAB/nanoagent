set -e
# The `pi` CLI, run from its package: the build image's own architecture's native packages only, no type
# declarations or source maps.
case "$(node -p process.arch)" in arm64) other=x64 ;; *) other=arm64 ;; esac
tar -C /deps --exclude="*linux-$other*" --exclude='*.d.ts' --exclude='*.d.cts' --exclude='*.d.mts' --exclude='*.map' -cf - node_modules | tar -C /build-out -xf -
