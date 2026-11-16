from . import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class CloneInfo(_message.Message):
    __slots__ = ("context_data", "created_thread_id", "created_thread_group_id", "created_thread_start_time_ns", "flags")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    CREATED_THREAD_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_THREAD_GROUP_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_THREAD_START_TIME_NS_FIELD_NUMBER: _ClassVar[int]
    FLAGS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    created_thread_id: int
    created_thread_group_id: int
    created_thread_start_time_ns: int
    flags: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., created_thread_id: _Optional[int] = ..., created_thread_group_id: _Optional[int] = ..., created_thread_start_time_ns: _Optional[int] = ..., flags: _Optional[int] = ...) -> None: ...

class ExecveInfo(_message.Message):
    __slots__ = ("context_data", "binary_path", "argv", "env", "binary_mode", "binary_uid", "binary_gid", "binary_sha256", "binary_sha1", "binary_overlayfs_upper", "binary_overlayfs_lower", "binary_ino", "binary_ctime", "binary_size", "binary_nlink", "binary_in_memfd", "stdin", "stdout", "stderr", "execfn", "pipe_input_proc", "pipe_output_proc")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    BINARY_PATH_FIELD_NUMBER: _ClassVar[int]
    ARGV_FIELD_NUMBER: _ClassVar[int]
    ENV_FIELD_NUMBER: _ClassVar[int]
    BINARY_MODE_FIELD_NUMBER: _ClassVar[int]
    BINARY_UID_FIELD_NUMBER: _ClassVar[int]
    BINARY_GID_FIELD_NUMBER: _ClassVar[int]
    BINARY_SHA256_FIELD_NUMBER: _ClassVar[int]
    BINARY_SHA1_FIELD_NUMBER: _ClassVar[int]
    BINARY_OVERLAYFS_UPPER_FIELD_NUMBER: _ClassVar[int]
    BINARY_OVERLAYFS_LOWER_FIELD_NUMBER: _ClassVar[int]
    BINARY_INO_FIELD_NUMBER: _ClassVar[int]
    BINARY_CTIME_FIELD_NUMBER: _ClassVar[int]
    BINARY_SIZE_FIELD_NUMBER: _ClassVar[int]
    BINARY_NLINK_FIELD_NUMBER: _ClassVar[int]
    BINARY_IN_MEMFD_FIELD_NUMBER: _ClassVar[int]
    STDIN_FIELD_NUMBER: _ClassVar[int]
    STDOUT_FIELD_NUMBER: _ClassVar[int]
    STDERR_FIELD_NUMBER: _ClassVar[int]
    EXECFN_FIELD_NUMBER: _ClassVar[int]
    PIPE_INPUT_PROC_FIELD_NUMBER: _ClassVar[int]
    PIPE_OUTPUT_PROC_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    binary_path: str
    argv: _containers.RepeatedScalarFieldContainer[str]
    env: _containers.RepeatedScalarFieldContainer[str]
    binary_mode: int
    binary_uid: int
    binary_gid: int
    binary_sha256: bytes
    binary_sha1: bytes
    binary_overlayfs_upper: bool
    binary_overlayfs_lower: bool
    binary_ino: int
    binary_ctime: _common_pb2.Timespec
    binary_size: int
    binary_nlink: int
    binary_in_memfd: bool
    stdin: _common_pb2.FdInfo
    stdout: _common_pb2.FdInfo
    stderr: _common_pb2.FdInfo
    execfn: str
    pipe_input_proc: PipeProcInfo
    pipe_output_proc: PipeProcInfo
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., binary_path: _Optional[str] = ..., argv: _Optional[_Iterable[str]] = ..., env: _Optional[_Iterable[str]] = ..., binary_mode: _Optional[int] = ..., binary_uid: _Optional[int] = ..., binary_gid: _Optional[int] = ..., binary_sha256: _Optional[bytes] = ..., binary_sha1: _Optional[bytes] = ..., binary_overlayfs_upper: _Optional[bool] = ..., binary_overlayfs_lower: _Optional[bool] = ..., binary_ino: _Optional[int] = ..., binary_ctime: _Optional[_Union[_common_pb2.Timespec, _Mapping]] = ..., binary_size: _Optional[int] = ..., binary_nlink: _Optional[int] = ..., binary_in_memfd: _Optional[bool] = ..., stdin: _Optional[_Union[_common_pb2.FdInfo, _Mapping]] = ..., stdout: _Optional[_Union[_common_pb2.FdInfo, _Mapping]] = ..., stderr: _Optional[_Union[_common_pb2.FdInfo, _Mapping]] = ..., execfn: _Optional[str] = ..., pipe_input_proc: _Optional[_Union[PipeProcInfo, _Mapping]] = ..., pipe_output_proc: _Optional[_Union[PipeProcInfo, _Mapping]] = ...) -> None: ...

class PipeProcInfo(_message.Message):
    __slots__ = ("context_data",)
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ...) -> None: ...

class ExitNotifyParentInfo(_message.Message):
    __slots__ = ("context_data", "exit_status")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_STATUS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit_status: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit_status: _Optional[int] = ...) -> None: ...

class TaskExit(_message.Message):
    __slots__ = ("context_data", "exit_status")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    EXIT_STATUS_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    exit_status: int
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., exit_status: _Optional[int] = ...) -> None: ...

class MmapInfo(_message.Message):
    __slots__ = ("context_data", "mapped_path", "mapped_ino", "mapped_mode", "mapped_uid", "mapped_gid", "is_initial_mmap", "mapped_ctime", "overlayfs_upper", "overlayfs_lower")
    CONTEXT_DATA_FIELD_NUMBER: _ClassVar[int]
    MAPPED_PATH_FIELD_NUMBER: _ClassVar[int]
    MAPPED_INO_FIELD_NUMBER: _ClassVar[int]
    MAPPED_MODE_FIELD_NUMBER: _ClassVar[int]
    MAPPED_UID_FIELD_NUMBER: _ClassVar[int]
    MAPPED_GID_FIELD_NUMBER: _ClassVar[int]
    IS_INITIAL_MMAP_FIELD_NUMBER: _ClassVar[int]
    MAPPED_CTIME_FIELD_NUMBER: _ClassVar[int]
    OVERLAYFS_UPPER_FIELD_NUMBER: _ClassVar[int]
    OVERLAYFS_LOWER_FIELD_NUMBER: _ClassVar[int]
    context_data: _common_pb2.ContextData
    mapped_path: str
    mapped_ino: int
    mapped_mode: int
    mapped_uid: int
    mapped_gid: int
    is_initial_mmap: bool
    mapped_ctime: _common_pb2.Timespec
    overlayfs_upper: bool
    overlayfs_lower: bool
    def __init__(self, context_data: _Optional[_Union[_common_pb2.ContextData, _Mapping]] = ..., mapped_path: _Optional[str] = ..., mapped_ino: _Optional[int] = ..., mapped_mode: _Optional[int] = ..., mapped_uid: _Optional[int] = ..., mapped_gid: _Optional[int] = ..., is_initial_mmap: _Optional[bool] = ..., mapped_ctime: _Optional[_Union[_common_pb2.Timespec, _Mapping]] = ..., overlayfs_upper: _Optional[bool] = ..., overlayfs_lower: _Optional[bool] = ...) -> None: ...
