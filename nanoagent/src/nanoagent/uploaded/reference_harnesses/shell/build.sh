set -e
# The terminal's files, and the CLIs' wrappers: each CLI is installed by the worker the first time it is typed (rush.py cli).
cp -R shell.py bashrc rush.py build.sh nanoagent_tools.py bin /build-out/
chmod 755 /build-out/bin/*
