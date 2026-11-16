"""Runs inside the relay container: forwards TCP connections on the attempt network to the worker's Unix socket.

    python relay_forward.py <socket path> <port>
"""

import asyncio
import sys

SOCKET, PORT = sys.argv[1], int(sys.argv[2])


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
    except OSError:
        writer.close()


async def handle(reader, writer):
    try:
        upstream_reader, upstream_writer = await asyncio.open_unix_connection(SOCKET)
    except OSError:
        writer.close()
        return
    await asyncio.gather(pipe(reader, upstream_writer), pipe(upstream_reader, writer))
    writer.close()
    upstream_writer.close()


async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", PORT)
    print("ready", flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
