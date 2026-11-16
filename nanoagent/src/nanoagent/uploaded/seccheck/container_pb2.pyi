from . import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Start(_message.Message):
    __slots__ = ("context_data", "id", "cwd", "args", "env", "terminal")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    CWD_FIELD_NUMBER: _ClassVar[int]
    ARGS_FIELD_NUMBER: _ClassVar[int]
    ENV_FIELD_NUMBER: _ClassVar[int]
    TERMINAL_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    id: str
    cwd: str
    args: _containers.RepeatedScalarFieldContainer[str]
    env: _containers.RepeatedScalarFieldContainer[str]
    terminal: bool
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., id: _Optional[str] = ..., cwd: _Optional[str] = ..., args: _Optional[_Iterable[str]] = ..., env: _Optional[_Iterable[str]] = ..., terminal: _Optional[bool] = ...) -> None: ...
