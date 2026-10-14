"""Run one plugin verifier function in this fresh process (see nanoagent.plugin.verifier).

It runs as ``nanoagent helper verifier``, writes no bytecode, and imports only the standard library
and slimconfig beyond NanoAgent's package itself. stdin is ``{"verifier", "contract", "function",
"arguments", "classes", "modules"}`` (``verifier``: the package folder; ``contract``: the plugin's
``contract.py``; ``classes``: for each argument, the contract class it is built into, or null);
stdout is the function's JSON result.
"""

import contextlib
import dataclasses
import enum
import importlib
import importlib.util
import json
import os
import socket
import subprocess
import sys

from slimconfig import Output, build_output, plain_output


PACKAGE = "plugin_verifier"
CONTRACT = "contract"


def _disabled(*_args, **_kwargs):
    raise PermissionError("plugin verifiers may not use the network or launch processes")


class _NoNewImports:
    """Refuse every module not already loaded once the verifier starts, except its own."""

    def find_spec(self, name, path=None, target=None):
        if name.startswith(PACKAGE + "."):
            return None  # the verifier's own modules, found by the normal path finder
        raise ImportError(f"plugin verifiers may not import {name!r}")


def _load(name, path, **options):
    spec = importlib.util.spec_from_file_location(name, path, **options)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    return spec, module


def _json(value):
    """A result's details as JSON: contract instances and Enum members as their JSON values."""
    if isinstance(value, Output) and dataclasses.is_dataclass(value):
        return plain_output(value)
    if isinstance(value, enum.Enum):
        return value.value
    raise TypeError(f"a verifier result holds {type(value).__name__}, which is not JSON")


def main(argv: list[str]) -> int:
    if argv:
        raise SystemExit("usage: nanoagent helper verifier < request.json")
    # No __pycache__ written into the plugin.
    sys.dont_write_bytecode = True
    request = json.load(sys.stdin)
    for module in request["modules"]:
        importlib.import_module(module)
    spec, contract = _load(CONTRACT, request["contract"])
    spec.loader.exec_module(contract)
    for owner, names in (
        (socket, ("socket", "create_connection", "getaddrinfo", "socketpair")),
        (subprocess, ("Popen", "run", "call", "check_call", "check_output")),
        (os, ("system", "popen", "fork", "execv", "execve", "execvp", "spawnv", "posix_spawn")),
    ):
        for name in names:
            if hasattr(owner, name):
                setattr(owner, name, _disabled)

    folder = request["verifier"]
    spec, module = _load(PACKAGE, os.path.join(folder, "__init__.py"), submodule_search_locations=[folder])
    sys.meta_path.insert(0, _NoNewImports())
    function_name, arguments, classes = request["function"], request["arguments"], request["classes"]

    def typed():
        """The arguments, each with a class built afresh into it, so no call sees another's."""
        return [
            value if name is None or value is None else build_output(value, getattr(contract, name))
            for value, name in zip(arguments, classes, strict=True)
        ]

    # A verifier's prints go to stderr so stdout stays the result.
    with contextlib.redirect_stdout(sys.stderr):
        spec.loader.exec_module(module)
        function = getattr(module, function_name)
        first = function(*typed())
        second = function(*typed())
    first_text = json.dumps(first, sort_keys=True, default=_json)
    if first_text != json.dumps(second, sort_keys=True, default=_json):
        raise RuntimeError(f"{function_name}() is not deterministic: two calls disagreed")
    sys.stdout.write(first_text)
    return 0
