set -e
# What a harness saved from the terminal builds from again (rush.py packs these), and the CLIs' wrappers: each CLI is installed
# by the worker the first time it is typed (rush.py cli), and a saved harness keeps the installs its session ran (clis.json).
cp -R shell.py bashrc rush.py build.sh pi-mcp.ts bin /build-out/
chmod 755 /build-out/bin/*
if [ -f clis.json ]; then cp clis.json /build-out/; fi
# A harness saved by `rush save`: the files built in the terminal, and the packages installed there.
if [ -d workspace ]; then cp -R workspace executables /build-out/; fi
if [ -f requirements.txt ]; then python -m pip install --quiet --no-index --find-links /deps --require-hashes --target /build-out/packages -r requirements.txt; fi
