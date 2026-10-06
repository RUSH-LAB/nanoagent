"""Run one plugin verifier function in this fresh interpreter (see nanoagent.plugin.verifier).

Standard library only: it runs as ``python -I -B <this file>``, outside the nanoagent package.
stdin is ``{"verifier", "function", "arguments", "modules"}`` (``verifier``: the package folder);
stdout is the function's JSON result.
"""

import contextlib
import copy
import importlib
import importlib.util
import json
import os
import socket
import subprocess
import sys


PACKAGE = "plugin_verifier"


def _disabled(*_args, **_kwargs):
    raise PermissionError("plugin verifiers may not use the network or launch processes")


class _NoNewImports:
    """Refuse every module not already loaded once the verifier starts, except its own."""

    def find_spec(self, name, path=None, target=None):
        if name.startswith(PACKAGE + "."):
            return None  # the verifier's own modules, found by the normal path finder
        raise ImportError(f"plugin verifiers may not import {name!r}")


def main() -> None:
    request = json.load(sys.stdin)
    for module in request["modules"]:
        importlib.import_module(module)
    for owner, names in (
        (socket, ("socket", "create_connection", "getaddrinfo", "socketpair")),
        (subprocess, ("Popen", "run", "call", "check_call", "check_output")),
        (os, ("system", "popen", "fork", "execv", "execve", "execvp", "spawnv", "posix_spawn")),
    ):
        for name in names:
            if hasattr(owner, name):
                setattr(owner, name, _disabled)

    folder = request["verifier"]
    spec = importlib.util.spec_from_file_location(
        PACKAGE, os.path.join(folder, "__init__.py"), submodule_search_locations=[folder]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = module
    sys.meta_path.insert(0, _NoNewImports())
    function_name, arguments = request["function"], request["arguments"]
    # A verifier's prints go to stderr so stdout stays the result.
    with contextlib.redirect_stdout(sys.stderr):
        spec.loader.exec_module(module)
        function = getattr(module, function_name)
        first = function(*copy.deepcopy(arguments))
        second = function(*copy.deepcopy(arguments))
    first_text = json.dumps(first, sort_keys=True)
    if first_text != json.dumps(second, sort_keys=True):
        raise RuntimeError(f"{function_name}() is not deterministic: two calls disagreed")
    sys.stdout.write(first_text)


if __name__ == "__main__":
    main()
