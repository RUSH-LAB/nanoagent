set -e
# What a harness saved from the terminal builds from again (rush.py packs these), and the CLIs' wrappers.
cp -R shell.py bashrc rush.py build.sh package.json package-lock.json clis.txt bin /build-out/
chmod 755 /build-out/bin/*
# The JavaScript CLIs from the lock (/deps/node_modules): platform binaries ship for linux x64 and arm64, and the build image's own
# architecture is the only one the run needs; no type declarations or source maps.
case "$(node -p process.arch)" in arm64) other=x64 ;; *) other=arm64 ;; esac
tar -C /deps --exclude="*linux-$other*" --exclude='*.d.ts' --exclude='*.d.cts' --exclude='*.d.mts' --exclude='*.map' -cf - node_modules | tar -C /build-out -xf -
# Hermes, from its hashed wheels (/deps/*.whl), apart from what the member installs.
python -m pip install --quiet --no-index --find-links /deps --require-hashes --target /build-out/site -r clis.txt
# A harness saved by `rush save`: the files built in the terminal, and the packages installed there.
if [ -d workspace ]; then cp -R workspace executables /build-out/; fi
if [ -f requirements.txt ]; then python -m pip install --quiet --no-index --find-links /deps --require-hashes --target /build-out/packages -r requirements.txt; fi
