#!/usr/bin/env bash
# The whole benchmark, resumably: step 1 makes the cases of every plugin without a cases file or a bug
# entry, step 3 runs every run that holds no result.json yet, and step 4 reports them all again.
# Overrides go to step 3, e.g. a trial on some plugins and harnesses:
#   run_all.sh -- 'plugins=[city-weather,mate-in-n]' 'harnesses=[nanoagent,pi]'

set -euo pipefail

[[ "${1:-}" == "--" ]] && shift
here="$(cd "$(dirname "$0")" && pwd)"
bash "$here/step1_make_cases.sh"
bash "$here/step3_batch_runs.sh" "$@"
bash "$here/step4_report.sh"
