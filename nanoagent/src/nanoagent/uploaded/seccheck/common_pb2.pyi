from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class MessageType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MESSAGE_UNKNOWN: _ClassVar[MessageType]
    MESSAGE_CONTAINER_START: _ClassVar[MessageType]
    MESSAGE_SENTRY_CLONE: _ClassVar[MessageType]
    MESSAGE_SENTRY_EXEC: _ClassVar[MessageType]
    MESSAGE_SENTRY_EXIT_NOTIFY_PARENT: _ClassVar[MessageType]
    MESSAGE_SENTRY_TASK_EXIT: _ClassVar[MessageType]
    MESSAGE_SYSCALL_RAW: _ClassVar[MessageType]
    MESSAGE_SYSCALL_OPEN: _ClassVar[MessageType]
    MESSAGE_SYSCALL_CLOSE: _ClassVar[MessageType]
    MESSAGE_SYSCALL_READ: _ClassVar[MessageType]
    MESSAGE_SYSCALL_CONNECT: _ClassVar[MessageType]
    MESSAGE_SYSCALL_EXECVE: _ClassVar[MessageType]
    MESSAGE_SYSCALL_SOCKET: _ClassVar[MessageType]
    MESSAGE_SYSCALL_CHDIR: _ClassVar[MessageType]
    MESSAGE_SYSCALL_SETID: _ClassVar[MessageType]
    MESSAGE_SYSCALL_SETRESID: _ClassVar[MessageType]
    MESSAGE_SYSCALL_PRLIMIT64: _ClassVar[MessageType]
    MESSAGE_SYSCALL_PIPE: _ClassVar[MessageType]
    MESSAGE_SYSCALL_FCNTL: _ClassVar[MessageType]
    MESSAGE_SYSCALL_DUP: _ClassVar[MessageType]
    MESSAGE_SYSCALL_SIGNALFD: _ClassVar[MessageType]
    MESSAGE_SYSCALL_CHROOT: _ClassVar[MessageType]
    MESSAGE_SYSCALL_EVENTFD: _ClassVar[MessageType]
    MESSAGE_SYSCALL_CLONE: _ClassVar[MessageType]
    MESSAGE_SYSCALL_BIND: _ClassVar[MessageType]
    MESSAGE_SYSCALL_ACCEPT: _ClassVar[MessageType]
    MESSAGE_SYSCALL_TIMERFD_CREATE: _ClassVar[MessageType]
    MESSAGE_SYSCALL_TIMERFD_SETTIME: _ClassVar[MessageType]
    MESSAGE_SYSCALL_TIMERFD_GETTIME: _ClassVar[MessageType]
    MESSAGE_SYSCALL_FORK: _ClassVar[MessageType]
    MESSAGE_SYSCALL_INOTIFY_INIT: _ClassVar[MessageType]
    MESSAGE_SYSCALL_INOTIFY_ADD_WATCH: _ClassVar[MessageType]
    MESSAGE_SYSCALL_INOTIFY_RM_WATCH: _ClassVar[MessageType]
    MESSAGE_SYSCALL_SOCKETPAIR: _ClassVar[MessageType]
    MESSAGE_SYSCALL_WRITE: _ClassVar[MessageType]
    MESSAGE_SENTRY_MMAP: _ClassVar[MessageType]
    MESSAGE_SYSCALL_MMAP: _ClassVar[MessageType]
    MESSAGE_SYSCALL_LISTEN: _ClassVar[MessageType]
    MESSAGE_SYSCALL_PTRACE: _ClassVar[MessageType]
MESSAGE_UNKNOWN: MessageType
MESSAGE_CONTAINER_START: MessageType
MESSAGE_SENTRY_CLONE: MessageType
MESSAGE_SENTRY_EXEC: MessageType
MESSAGE_SENTRY_EXIT_NOTIFY_PARENT: MessageType
MESSAGE_SENTRY_TASK_EXIT: MessageType
MESSAGE_SYSCALL_RAW: MessageType
MESSAGE_SYSCALL_OPEN: MessageType
MESSAGE_SYSCALL_CLOSE: MessageType
MESSAGE_SYSCALL_READ: MessageType
MESSAGE_SYSCALL_CONNECT: MessageType
MESSAGE_SYSCALL_EXECVE: MessageType
MESSAGE_SYSCALL_SOCKET: MessageType
MESSAGE_SYSCALL_CHDIR: MessageType
MESSAGE_SYSCALL_SETID: MessageType
MESSAGE_SYSCALL_SETRESID: MessageType
MESSAGE_SYSCALL_PRLIMIT64: MessageType
MESSAGE_SYSCALL_PIPE: MessageType
MESSAGE_SYSCALL_FCNTL: MessageType
MESSAGE_SYSCALL_DUP: MessageType
MESSAGE_SYSCALL_SIGNALFD: MessageType
MESSAGE_SYSCALL_CHROOT: MessageType
MESSAGE_SYSCALL_EVENTFD: MessageType
MESSAGE_SYSCALL_CLONE: MessageType
MESSAGE_SYSCALL_BIND: MessageType
MESSAGE_SYSCALL_ACCEPT: MessageType
MESSAGE_SYSCALL_TIMERFD_CREATE: MessageType
MESSAGE_SYSCALL_TIMERFD_SETTIME: MessageType
MESSAGE_SYSCALL_TIMERFD_GETTIME: MessageType
MESSAGE_SYSCALL_FORK: MessageType
MESSAGE_SYSCALL_INOTIFY_INIT: MessageType
MESSAGE_SYSCALL_INOTIFY_ADD_WATCH: MessageType
MESSAGE_SYSCALL_INOTIFY_RM_WATCH: MessageType
MESSAGE_SYSCALL_SOCKETPAIR: MessageType
MESSAGE_SYSCALL_WRITE: MessageType
MESSAGE_SENTRY_MMAP: MessageType
MESSAGE_SYSCALL_MMAP: MessageType
MESSAGE_SYSCALL_LISTEN: MessageType
MESSAGE_SYSCALL_PTRACE: MessageType

class Handshake(_message.Message):
    __slots__ = ("version",)
    VERSION_FIELD_NUMBER: _ClassVar[int]
    version: int
    def __init__(self, version: _Optional[int] = ...) -> None: ...

class Timespec(_message.Message):
    __slots__ = ("sec", "nsec")
    SEC_FIELD_NUMBER: _ClassVar[int]
    NSEC_FIELD_NUMBER: _ClassVar[int]
    sec: int
    nsec: int
    def __init__(self, sec: _Optional[int] = ..., nsec: _Optional[int] = ...) -> None: ...

class Credentials(_message.Message):
    __slots__ = ("real_uid", "effective_uid", "saved_uid", "real_gid", "effective_gid", "saved_gid")
    REAL_UID_FIELD_NUMBER: _ClassVar[int]
    EFFECTIVE_UID_FIELD_NUMBER: _ClassVar[int]
    SAVED_UID_FIELD_NUMBER: _ClassVar[int]
    REAL_GID_FIELD_NUMBER: _ClassVar[int]
    EFFECTIVE_GID_FIELD_NUMBER: _ClassVar[int]
    SAVED_GID_FIELD_NUMBER: _ClassVar[int]
    real_uid: int
    effective_uid: int
    saved_uid: int
    real_gid: int
    effective_gid: int
    saved_gid: int
    def __init__(self, real_uid: _Optional[int] = ..., effective_uid: _Optional[int] = ..., saved_uid: _Optional[int] = ..., real_gid: _Optional[int] = ..., effective_gid: _Optional[int] = ..., saved_gid: _Optional[int] = ...) -> None: ...

class ContextData(_message.Message):
    __slots__ = ("time_ns", "thread_id", "thread_start_time_ns", "thread_group_id", "thread_group_start_time_ns", "container_id", "credentials", "cwd", "process_name", "parent_thread_group_id", "is_exec_session")
    TIME_NS_FIELD_NUMBER: _ClassVar[int]
    THREAD_ID_FIELD_NUMBER: _ClassVar[int]
    THREAD_START_TIME_NS_FIELD_NUMBER: _ClassVar[int]
    THREAD_GROUP_ID_FIELD_NUMBER: _ClassVar[int]
    THREAD_GROUP_START_TIME_NS_FIELD_NUMBER: _ClassVar[int]
    CONTAINER_ID_FIELD_NUMBER: _ClassVar[int]
    CREDENTIALS_FIELD_NUMBER: _ClassVar[int]
    CWD_FIELD_NUMBER: _ClassVar[int]
    PROCESS_NAME_FIELD_NUMBER: _ClassVar[int]
    PARENT_THREAD_GROUP_ID_FIELD_NUMBER: _ClassVar[int]
    IS_EXEC_SESSION_FIELD_NUMBER: _ClassVar[int]
    time_ns: int
    thread_id: int
    thread_start_time_ns: int
    thread_group_id: int
    thread_group_start_time_ns: int
    container_id: str
    credentials: Credentials
    cwd: str
    process_name: str
    parent_thread_group_id: int
    is_exec_session: bool
    def __init__(self, time_ns: _Optional[int] = ..., thread_id: _Optional[int] = ..., thread_start_time_ns: _Optional[int] = ..., thread_group_id: _Optional[int] = ..., thread_group_start_time_ns: _Optional[int] = ..., container_id: _Optional[str] = ..., credentials: _Optional[_Union[Credentials, _Mapping]] = ..., cwd: _Optional[str] = ..., process_name: _Optional[str] = ..., parent_thread_group_id: _Optional[int] = ..., is_exec_session: _Optional[bool] = ...) -> None: ...

class SocketIp(_message.Message):
    __slots__ = ("family", "ip", "port")
    FAMILY_FIELD_NUMBER: _ClassVar[int]
    IP_FIELD_NUMBER: _ClassVar[int]
    PORT_FIELD_NUMBER: _ClassVar[int]
    family: int
    ip: bytes
    port: int
    def __init__(self, family: _Optional[int] = ..., ip: _Optional[bytes] = ..., port: _Optional[int] = ...) -> None: ...

class SocketInfo(_message.Message):
    __slots__ = ("family", "local", "remote")
    FAMILY_FIELD_NUMBER: _ClassVar[int]
    LOCAL_FIELD_NUMBER: _ClassVar[int]
    REMOTE_FIELD_NUMBER: _ClassVar[int]
    family: int
    local: SocketIp
    remote: SocketIp
    def __init__(self, family: _Optional[int] = ..., local: _Optional[_Union[SocketIp, _Mapping]] = ..., remote: _Optional[_Union[SocketIp, _Mapping]] = ...) -> None: ...

class FdInfo(_message.Message):
    __slots__ = ("mode", "ino", "path", "socket")
    MODE_FIELD_NUMBER: _ClassVar[int]
    INO_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    SOCKET_FIELD_NUMBER: _ClassVar[int]
    mode: int
    ino: int
    path: str
    socket: SocketInfo
    def __init__(self, mode: _Optional[int] = ..., ino: _Optional[int] = ..., path: _Optional[str] = ..., socket: _Optional[_Union[SocketInfo, _Mapping]] = ...) -> None: ...
