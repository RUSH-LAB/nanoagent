"""The tools that ship with nanoagent, one module each.

Every one is a :class:`~nanoagent.core.tool.Tool` subclass reached the same way a user's own tool
is — a YAML naming ``code: src/nanoagent/tools/<name>.py`` — so nothing here is privileged and
none of it is loaded unless a config asks for it.
"""
