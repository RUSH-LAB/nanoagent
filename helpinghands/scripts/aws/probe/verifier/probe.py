import json

from .checks import result

# What the runner's NanoAgent holds, which no plugin may see.
SECRETS = ("NANOAGENT_API_TOKEN", "OPENROUTER_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN")


def verify_input(tool, value):
    return result(True, "input is valid")


def verify_output(tool, input_value, output_value, workspace):
    return result(True, "output is well formed")


def verify_probe(arguments, output, reference, workspace):
    report = json.loads(output.report)
    held = {
        "no secret in its environment": not any(name in report["environment"] for name in SECRETS),
        "no network of its own": report["direct"].startswith("refused"),
        "its declared host, through the proxy": report["declared"].startswith("reached"),
        "no undeclared host": report["undeclared"].startswith("refused"),
        "no private address": report["private"].startswith("refused") and report["metadata"].startswith("refused"),
        "its own folder read-only": report["plugin_folder"].startswith("refused"),
        "its workspace writable": report["workspace"] == "written",
        "no other install": report["installs"] == [report["own_install"]],
        "no other run's folder": report["workspaces"] == [report["own_workspace"]],
        "none of the runner's processes": report["first_process_secrets"] is False,
        "no user namespace of its own": report["user_namespace"].startswith("refused"),
        "the first stopped when memory runs out": report["oom_score_adj"] == "1000",
    }
    failed = [name for name, ok in held.items() if not ok]
    if failed:
        return result(False, "the sandbox did not hold: " + ", ".join(failed), held=held)
    return result(True, "the sandbox held", held=held)


def verify_hog(arguments, output, reference, workspace):
    return result(output.held < arguments.megabytes, f"held {output.held} of {arguments.megabytes} MB")


def verify_swarm(arguments, output, reference, workspace):
    return result(output.killed > 0, f"the kernel stopped {output.killed} of the {output.started} processes it started")


def verify_forks(arguments, output, reference, workspace):
    return result(output.started < arguments.count, f"started {output.started} of {arguments.count} processes")
