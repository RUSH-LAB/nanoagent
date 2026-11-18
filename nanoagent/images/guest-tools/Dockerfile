# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# The worker's guest tools (nanoagent.uploaded.sandbox, TOOLS_DIR): a static strace, built from its sha256-pinned release
# tarball in the pinned gcc image, and uv's static Linux release. One binary of each runs in every runtime image.

# gcc:14-bookworm
FROM gcc@sha256:5e927c284bf55a7dc796262e311a0703344f62f41f5621eb56843111b1d37e15 AS strace
ADD --checksum=sha256:529634c40910895a9a1f3c5c1e65da2ca9ed72fb158dfc4bcc89efdf05e39b72 \
    https://github.com/strace/strace/releases/download/v7.3/strace-7.3.tar.xz /strace.tar.xz
RUN mkdir /b && tar -C /b -xJf /strace.tar.xz && cd /b/strace-7.3 \
    && ./configure -q --enable-mpers=no --disable-gcc-Werror --without-libdw --without-libunwind --without-libselinux LDFLAGS=-static \
    && make -s -j"$(nproc)" && strip -o /strace src/strace

# uv 0.10.9
FROM ghcr.io/astral-sh/uv@sha256:10902f58a1606787602f303954cea099626a4adb02acbac4c69920fe9d278f82 AS uv

FROM scratch
COPY --from=strace /strace /strace
COPY --from=uv /uv /uv
