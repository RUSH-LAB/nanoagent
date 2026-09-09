"""The human-facing terminal layer: the chat REPL, its commands, its transcript tree, the browser.

None of this is on the rollout path. :mod:`~nanoagent.cli.repl.app` drives the SAME
:meth:`~nanoagent.core.agent.Agent.run` a batch rollout does, wrapping the model and the tools to
narrate and confirm rather than reimplementing the loop.
"""
