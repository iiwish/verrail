#!/usr/bin/env python3
"""Bound a command's output; the outer container deadline owns final cleanup."""
import base64
import json
import os
import selectors
import subprocess
import sys


def main():
    command = base64.b64decode(sys.argv[1], validate=True).decode('utf-8')
    child = subprocess.Popen(['/bin/sh', '-c', command], cwd='/work',
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/work', 'TMPDIR': '/tmp',
                                  'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
                                  'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'})
    streams = {'stdout': bytearray(), 'stderr': bytearray()}
    size = 0
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
        while selector.get_map():
            for key, _ in selector.select():
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                size += len(data)
                if size > 1024 * 1024:
                    print(json.dumps({'exitCode': 1, 'stdout': '', 'stderr': '', 'error': 'output_limit'}), flush=True)
                    # Exiting the outer PID 1 timeout tears down every descendant,
                    # including commands that detached into another process group.
                    return 1
                streams[key.data].extend(data)
    code = child.wait()
    print(json.dumps({'exitCode': code, **{k: bytes(v).decode('utf-8', errors='replace') for k, v in streams.items()}}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
