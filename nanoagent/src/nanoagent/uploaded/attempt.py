"""What the gateway, tool broker, command service and event endpoint share for one attempt: its pinned policy,
authentication, revocation and the in-flight work revocation has to stop."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
import uuid
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse

from nanoagent.uploaded.contract import DIALECTS, ContractError, validate
from nanoagent.uploaded.evidence import Recorder

SPAN_HEADER = "x-rush-span-id"
CALL_HEADER = "X-Rush-Call-Id"
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

# Far enough under evidence.MAX_PAYLOAD_BYTES that the journaled request and its effective twin (a few hundred bytes more) fit whole.
MAX_BODY_BYTES = 8 << 20


class ServiceError(Exception):
    """A refusal with its HTTP status; ``code`` is stable and machine readable."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.message = message


def from_contract(error: ContractError) -> ServiceError:
    return ServiceError(413 if error.code == "too_large" else 400, error.code, error.message)


def error_response(error: ServiceError, call_id: str | None = None, *, anthropic: bool = False) -> JSONResponse:
    detail: dict[str, Any] = {"code": error.code, "message": error.message}
    payload: dict[str, Any] = {"error": detail}
    if anthropic:
        # The Anthropic SDK reads `type` at both levels.
        detail["type"] = error.code
        payload["type"] = "error"
    return JSONResponse(payload, status_code=error.status, headers={CALL_HEADER: call_id} if call_id else None)


def tool_error_response(error: ServiceError, call_id: str) -> JSONResponse:
    """The error as a `ToolResult` envelope, checked against the contract before it is sent."""
    response = error_response(error, call_id)
    validate("ToolResult", json.loads(response.body))
    return response


def new_call_id() -> str:
    return str(uuid.uuid4())


@dataclass(frozen=True)
class ToolPolicy:
    """A tool the attempt may call. ``writes`` tools get exclusive workspace access among brokered calls."""

    name: str
    writes: bool
    input_schema: Mapping[str, Any]
    output_schema: Mapping[str, Any]


@dataclass(frozen=True)
class AttemptPolicy:
    """Everything the services pin for one attempt."""

    attempt_id: str
    token: str = field(repr=False)
    model: str
    dialects: tuple[str, ...]
    prompt_user: str | None  # the pinned rendered prompt: either part may be absent, not both
    prompt_system: str | None
    max_model_calls: int
    max_output_tokens_per_call: int
    input_price_bound: Decimal  # USD per input token, an upper bound
    output_price_bound: Decimal  # USD per output token, an upper bound
    provider: Mapping[str, Any] = field(default_factory=dict)  # pinned routing, e.g. {"order": ["fireworks"]}
    tools: tuple[ToolPolicy, ...] = ()
    max_request_bytes: int = MAX_BODY_BYTES

    def __post_init__(self) -> None:
        if not self.token or not self.model:
            raise ValueError("an attempt policy needs a token and a model")
        unknown = [dialect for dialect in self.dialects if dialect not in DIALECTS]
        if unknown or not self.dialects:
            raise ValueError(f"dialects must be a non-empty subset of {DIALECTS}, got {self.dialects}")
        if self.prompt_user is None and self.prompt_system is None:
            raise ValueError("an attempt policy needs a user prompt, a system prompt or both")
        if self.max_model_calls < 1 or self.max_output_tokens_per_call < 1:
            raise ValueError("max_model_calls and max_output_tokens_per_call must be positive")
        for name, price in (("input_price_bound", self.input_price_bound), ("output_price_bound", self.output_price_bound)):
            if not price.is_finite() or price < 0:
                raise ValueError(f"{name} must be a finite non-negative Decimal, got {price}")
        if self.provider.get("allow_fallbacks") not in (None, False):
            raise ValueError("the pinned provider routing cannot allow fallbacks")
        if len({tool.name for tool in self.tools}) != len(self.tools):
            raise ValueError("tool names must be unique")

    def tool(self, name: str) -> ToolPolicy | None:
        return next((tool for tool in self.tools if tool.name == name), None)


class Attempt:
    """The per-attempt context: authentication, the revoked flag and the in-flight work revocation stops."""

    def __init__(
        self,
        policy: AttemptPolicy,
        recorder: Recorder,
        workspace: Path,
        clock_ns: Callable[[], int] = time.monotonic_ns,
        # The lease's local fence, given by the runner: True once the lease's known expiry passed without a renewal.
        lease_lapsed: Callable[[], bool] = lambda: False,
    ) -> None:
        self.policy = policy
        self.recorder = recorder
        self.workspace = workspace
        self.clock_ns = clock_ns
        self.revoked = False
        self.lease_lapsed = lease_lapsed
        self._token_digest = hashlib.sha256(policy.token.encode()).digest()
        self._scopes: set[anyio.CancelScope] = set()

    def authenticate(self, request: Request) -> bool:
        """Constant-time check of the attempt token in `Authorization: Bearer` or `x-api-key`."""
        scheme, _, credential = request.headers.get("authorization", "").partition(" ")
        offered = [request.headers.get("x-api-key"), credential.strip() if scheme.lower() == "bearer" else None]
        # Both candidates are always compared so the outcome does not depend on which header carried the token.
        matches = [hmac.compare_digest(hashlib.sha256(value.encode()).digest(), self._token_digest) for value in offered if value is not None]
        return any(matches)

    def require_auth(self, request: Request) -> None:
        if not self.authenticate(request):
            raise ServiceError(401, "unauthorized", "missing or invalid attempt token")

    def require_active(self) -> None:
        if self.revoked:
            raise ServiceError(403, "revoked", "the attempt's service admission was revoked")
        if self.lease_lapsed():
            raise ServiceError(403, "lease_lost", "the attempt's lease expired without a renewal")

    @staticmethod
    def span_id(request: Request) -> str | None:
        value = request.headers.get(SPAN_HEADER)
        if value is not None and not _ID.match(value):
            raise ServiceError(400, "invalid_span_id", f"{SPAN_HEADER} must match {_ID.pattern}")
        return value

    async def read_body(self, request: Request) -> bytes:
        limit = self.policy.max_request_bytes
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            raise ServiceError(413, "request_too_large", f"{declared} bytes exceeds the {limit} byte limit")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > limit:
                raise ServiceError(413, "request_too_large", f"the body exceeds the {limit} byte limit")
        return bytes(body)

    @contextmanager
    def tracked(self):
        """Run work that revocation may cancel and drain: ``with attempt.tracked():`` around tool and exec calls."""
        scope = anyio.CancelScope()
        self._scopes.add(scope)
        try:
            with scope:
                if self.revoked:
                    scope.cancel()
                yield scope
        finally:
            self._scopes.discard(scope)

    def cancel_tracked(self) -> None:
        for scope in list(self._scopes):
            scope.cancel()

    async def drain(self, timeout: float) -> None:
        """Wait for tracked work to finish; raises TimeoutError naming how much is left."""
        try:
            with anyio.fail_after(timeout):
                while self._scopes:
                    await anyio.sleep(0.01)
        except TimeoutError as error:
            raise TimeoutError(f"{len(self._scopes)} tracked tool or exec calls were still running after {timeout} s") from error
