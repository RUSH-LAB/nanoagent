set -e
# Platform binaries ship for linux x64 and arm64; the build image's own architecture is the only one the run needs.
case "$(node -p process.arch)" in arm64) other=x64 ;; *) other=arm64 ;; esac
tar -C /deps --exclude="*linux-$other*" -cf - node_modules | tar -C /build-out -xf -
