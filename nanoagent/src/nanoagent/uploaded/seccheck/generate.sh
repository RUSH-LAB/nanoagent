#!/usr/bin/env bash
# Regenerates the *_pb2 modules from the vendored gVisor .proto sources in proto/.
# The sources are verbatim copies from google/gvisor at the tag in proto/GVISOR_COMMIT
# (pkg/sentry/seccheck/points/*.proto); never edit them by hand. The generated code requires
# a protobuf runtime >= the version in its header (see the `protobuf` pin in pyproject.toml).
set -euo pipefail
cd "$(dirname "$0")"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/pkg/sentry/seccheck/points" "$stage/out"
cp proto/*.proto "$stage/pkg/sentry/seccheck/points/"
(cd "$stage" && uv run --no-project --with grpcio-tools python -m grpc_tools.protoc -I. \
    --python_out=out --pyi_out=out pkg/sentry/seccheck/points/*.proto)
for f in "$stage"/out/pkg/sentry/seccheck/points/*; do
    # The protos import each other by their gVisor repository path; make that package-relative.
    sed 's/^from pkg\.sentry\.seccheck\.points import \(.*\)_pb2 as/from . import \1_pb2 as/' "$f" > "$(basename "$f")"
done
