from . import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Exit(_message.Message):
    __slots__ = ("result", "errorno")
    RESULT_FIELD_NUMBER: _ClassVar[int]
    ERRORNO_FIELD_NUMBER: _ClassVar[int]
    result: int
    errorno: int
    def __init__(self, result: _Optional[int] = ..., errorno: _Optional[int] = ...) -> None: ...

class Syscall(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "arg1", "arg2", "arg3", "arg4", "arg5", "arg6")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    ARG1_FIELD_NUMBER: _ClassVar[int]
    ARG2_FIELD_NUMBER: _ClassVar[int]
    ARG3_FIELD_NUMBER: _ClassVar[int]
    ARG4_FIELD_NUMBER: _ClassVar[int]
    ARG5_FIELD_NUMBER: _ClassVar[int]
    ARG6_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    arg1: int
    arg2: int
    arg3: int
    arg4: int
    arg5: int
    arg6: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., arg1: _Optional[int] = ..., arg2: _Optional[int] = ..., arg3: _Optional[int] = ..., arg4: _Optional[int] = ..., arg5: _Optional[int] = ..., arg6: _Optional[int] = ...) -> None: ...

class Open(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "pathname", "flags", "mode")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    PATHNAME_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    pathname: str
    flags: int
    mode: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., pathname: _Optional[str] = ..., flags: _Optional[int] = ..., mode: _Optional[int] = ...) -> None: ...

class Close(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ...) -> None: ...

class Read(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "count", "has_offset", "offset", "flags")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    HAS_OFFSET_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    count: int
    has_offset: bool
    offset: int
    flags: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., count: _Optional[int] = ..., has_offset: _Optional[bool] = ..., offset: _Optional[int] = ..., flags: _Optional[int] = ...) -> None: ...

class Write(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "count", "has_offset", "offset", "flags")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    HAS_OFFSET_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    count: int
    has_offset: bool
    offset: int
    flags: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., count: _Optional[int] = ..., has_offset: _Optional[bool] = ..., offset: _Optional[int] = ..., flags: _Optional[int] = ...) -> None: ...

class Connect(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "address")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    address: bytes
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., address: _Optional[bytes] = ...) -> None: ...

class Execve(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "pathname", "argv", "envv", "flags")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    PATHNAME_FIELD_NUMBER: _ClassVar[int]
    ARGV_FIELD_NUMBER: _ClassVar[int]
    ENVV_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    pathname: str
    argv: _containers.RepeatedScalarFieldContainer[str]
    envv: _containers.RepeatedScalarFieldContainer[str]
    flags: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., pathname: _Optional[str] = ..., argv: _Optional[_Iterable[str]] = ..., envv: _Optional[_Iterable[str]] = ..., flags: _Optional[int] = ...) -> None: ...

class Socket(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "domain", "type", "protocol")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    DOMAIN_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    domain: int
    type: int
    protocol: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., domain: _Optional[int] = ..., type: _Optional[int] = ..., protocol: _Optional[int] = ...) -> None: ...

class Chdir(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "pathname")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    PATHNAME_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    pathname: str
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., pathname: _Optional[str] = ...) -> None: ...

class Setresid(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "rid", "eid", "sid")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    RID_FIELD_NUMBER: _ClassVar[int]
    EID_FIELD_NUMBER: _ClassVar[int]
    SID_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    rid: int
    eid: int
    sid: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., rid: _Optional[int] = ..., eid: _Optional[int] = ..., sid: _Optional[int] = ...) -> None: ...

class Setid(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "id")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    id: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., id: _Optional[int] = ...) -> None: ...

class StructRlimit(_message.Message):
    __slots__ = ("cur", "max")
    CUR_FIELD_NUMBER: _ClassVar[int]
    MAX_FIELD_NUMBER: _ClassVar[int]
    cur: int
    max: int
    def __init__(self, cur: _Optional[int] = ..., max: _Optional[int] = ...) -> None: ...

class Prlimit(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "pid", "resource", "new_limit", "old_limit")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    PID_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_FIELD_NUMBER: _ClassVar[int]
    NEW_LIMIT_FIELD_NUMBER: _ClassVar[int]
    OLD_LIMIT_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    pid: int
    resource: int
    new_limit: StructRlimit
    old_limit: StructRlimit
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., pid: _Optional[int] = ..., resource: _Optional[int] = ..., new_limit: _Optional[_Union[StructRlimit, _Mapping]] = ..., old_limit: _Optional[_Union[StructRlimit, _Mapping]] = ...) -> None: ...

class Pipe(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "flags", "reader", "writer")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    READER_FIELD_NUMBER: _ClassVar[int]
    WRITER_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    flags: int
    reader: int
    writer: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., flags: _Optional[int] = ..., reader: _Optional[int] = ..., writer: _Optional[int] = ...) -> None: ...

class Fcntl(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "cmd", "args")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    CMD_FIELD_NUMBER: _ClassVar[int]
    ARGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    cmd: int
    args: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., cmd: _Optional[int] = ..., args: _Optional[int] = ...) -> None: ...

class Dup(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "old_fd", "new_fd", "fd_path", "flags")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    OLD_FD_FIELD_NUMBER: _ClassVar[int]
    NEW_FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    old_fd: int
    new_fd: int
    fd_path: str
    flags: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., old_fd: _Optional[int] = ..., new_fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., flags: _Optional[int] = ...) -> None: ...

class Signalfd(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "sigset", "flags")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    SIGSET_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    sigset: int
    flags: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., sigset: _Optional[int] = ..., flags: _Optional[int] = ...) -> None: ...

class Chroot(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "pathname")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    PATHNAME_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    pathname: str
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., pathname: _Optional[str] = ...) -> None: ...

class Eventfd(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "val", "flags")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    VAL_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    val: int
    flags: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., val: _Optional[int] = ..., flags: _Optional[int] = ...) -> None: ...

class Clone(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "flags", "stack", "new_tid", "tls")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    STACK_FIELD_NUMBER: _ClassVar[int]
    NEW_TID_FIELD_NUMBER: _ClassVar[int]
    TLS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    flags: int
    stack: int
    new_tid: int
    tls: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., flags: _Optional[int] = ..., stack: _Optional[int] = ..., new_tid: _Optional[int] = ..., tls: _Optional[int] = ...) -> None: ...

class Bind(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "address")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    address: bytes
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., address: _Optional[bytes] = ...) -> None: ...

class Accept(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "address", "flags")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    address: bytes
    flags: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., address: _Optional[bytes] = ..., flags: _Optional[int] = ...) -> None: ...

class Listen(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "backlog", "address", "socket_family", "socket_type")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    BACKLOG_FIELD_NUMBER: _ClassVar[int]
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    SOCKET_FAMILY_FIELD_NUMBER: _ClassVar[int]
    SOCKET_TYPE_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    backlog: int
    address: bytes
    socket_family: int
    socket_type: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., backlog: _Optional[int] = ..., address: _Optional[bytes] = ..., socket_family: _Optional[int] = ..., socket_type: _Optional[int] = ...) -> None: ...

class TimerfdCreate(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "clock_id", "flags")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    CLOCK_ID_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    clock_id: int
    flags: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., clock_id: _Optional[int] = ..., flags: _Optional[int] = ...) -> None: ...

class ItimerSpec(_message.Message):
    __slots__ = ("interval", "value")
    INTERVAL_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    interval: _common_pb2.Timespec
    value: _common_pb2.Timespec
    def __init__(self, interval: _Optional[_Union[_common_pb2.Timespec, _Mapping]] = ..., value: _Optional[_Union[_common_pb2.Timespec, _Mapping]] = ...) -> None: ...

class TimerfdSetTime(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "flags", "new_value", "old_value")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    NEW_VALUE_FIELD_NUMBER: _ClassVar[int]
    OLD_VALUE_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    flags: int
    new_value: ItimerSpec
    old_value: ItimerSpec
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., flags: _Optional[int] = ..., new_value: _Optional[_Union[ItimerSpec, _Mapping]] = ..., old_value: _Optional[_Union[ItimerSpec, _Mapping]] = ...) -> None: ...

class TimerfdGetTime(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "cur_value")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    CUR_VALUE_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    cur_value: ItimerSpec
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., cur_value: _Optional[_Union[ItimerSpec, _Mapping]] = ...) -> None: ...

class Fork(_message.Message):
    __slots__ = ("context_data", "exit", "sysno")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ...) -> None: ...

class InotifyInit(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "flags")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    flags: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., flags: _Optional[int] = ...) -> None: ...

class InotifyAddWatch(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "pathname", "mask")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    PATHNAME_FIELD_NUMBER: _ClassVar[int]
    MASK_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    pathname: str
    mask: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., pathname: _Optional[str] = ..., mask: _Optional[int] = ...) -> None: ...

class InotifyRmWatch(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "wd")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    WD_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    wd: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., wd: _Optional[int] = ...) -> None: ...

class SocketPair(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "domain", "type", "protocol", "socket1", "socket2")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    DOMAIN_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    SOCKET1_FIELD_NUMBER: _ClassVar[int]
    SOCKET2_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    domain: int
    type: int
    protocol: int
    socket1: int
    socket2: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., domain: _Optional[int] = ..., type: _Optional[int] = ..., protocol: _Optional[int] = ..., socket1: _Optional[int] = ..., socket2: _Optional[int] = ...) -> None: ...

class Mmap(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "fd", "fd_path", "addr", "length", "prot", "flags", "offset")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    FD_FIELD_NUMBER: _ClassVar[int]
    FD_PATH_FIELD_NUMBER: _ClassVar[int]
    ADDR_FIELD_NUMBER: _ClassVar[int]
    LENGTH_FIELD_NUMBER: _ClassVar[int]
    PROT_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    fd: int
    fd_path: str
    addr: int
    length: int
    prot: int
    flags: int
    offset: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., fd: _Optional[int] = ..., fd_path: _Optional[str] = ..., addr: _Optional[int] = ..., length: _Optional[int] = ..., prot: _Optional[int] = ..., flags: _Optional[int] = ..., offset: _Optional[int] = ...) -> None: ...

class Ptrace(_message.Message):
    __slots__ = ("context_data", "exit", "sysno", "request", "pid")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_FIELD_NUMBER: _ClassVar[int]
    SYSNO_FIELD_NUMBER: _ClassVar[int]
    REQUEST_FIELD_NUMBER: _ClassVar[int]
    PID_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit: Exit
    sysno: int
    request: int
    pid: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit: _Optional[_Union[Exit, _Mapping]] = ..., sysno: _Optional[int] = ..., request: _Optional[int] = ..., pid: _Optional[int] = ...) -> None: ...
