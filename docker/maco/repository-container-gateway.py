#!/usr/bin/python3
"""Fixed-command SSH gateway for secret-free, offline Verrail command containers.

Install root-owned outside the checkout. This is an operations helper, not a
general Docker API. Each request exits; deadlines run inside Docker, not a host
worker. The forced SSH identity must have no shell, forwarding or Docker access.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

LIMIT = 1024 * 1024
LABEL = 'ai.verrail.command-owner'
MAX_SCRATCH = 512 * 1024 * 1024


def atomic_json(path, data):
    fd, tmp = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def private_path(path, uid, directory=False):
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('unprotected path')
    if str(path.resolve()) != str(path):
        raise ValueError('symlink path')


def load_policy(path):
    private_path(path, 0)
    p = json.loads(path.read_text())
    if set(p) != {'project', 'image', 'workspaceRoot', 'stateRoot'}:
        raise ValueError('invalid policy')
    if p['project'] != 'verrail-test' or not re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}', p['image']):
        raise ValueError('invalid identity')
    if p['workspaceRoot'] != '/opt/maco-apps/verrail/test/data/repository/workspaces':
        raise ValueError('invalid workspace root')
    if p['stateRoot'] != '/opt/maco-ops/apps/verrail/test/container-commands':
        raise ValueError('invalid state root')
    private_path(Path(p['workspaceRoot']), 1000, directory=True)
    private_path(Path(p['stateRoot']), 0, directory=True)
    fs = os.statvfs(p['workspaceRoot'])
    if fs.f_blocks * fs.f_frsize > MAX_SCRATCH:
        raise ValueError('unbounded scratch')
    mount = next((line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()
                  if line.split()[4] == p['workspaceRoot']), None)
    if not mount or mount[mount.index('-') + 1] != 'tmpfs':
        raise ValueError('scratch must be a dedicated tmpfs')
    return p


def validate_request(r):
    if not isinstance(r, dict) or r.get('version') != 1 or isinstance(r.get('version'), bool):
        raise ValueError('invalid protocol')
    if r.get('operation') not in ('start', 'poll', 'stop'):
        raise ValueError('invalid operation')
    if str(uuid.UUID(r.get('commandId', ''))) != r['commandId']:
        raise ValueError('invalid command identity')
    fields = {'version', 'operation', 'commandId'}
    if r['operation'] == 'start':
        fields |= {'workspace', 'command', 'timeoutSeconds'}
        if not isinstance(r.get('workspace'), str) or not re.fullmatch(r'verrail-repository-[A-Za-z0-9_-]+/checkout', r['workspace']):
            raise ValueError('invalid workspace')
        if not isinstance(r.get('command'), str) or not 0 < len(r['command'].encode()) <= 80_000 or '\0' in r['command']:
            raise ValueError('invalid command')
        if type(r.get('timeoutSeconds')) is not int or not 1 <= r['timeoutSeconds'] <= 120:
            raise ValueError('invalid deadline')
    if set(r) != fields:
        raise ValueError('unexpected fields')
    return r


class Gateway:
    def __init__(self, policy):
        self.policy = policy
        self.state = Path(policy['stateRoot'])

    def docker(self, *args, limit=2*LIMIT, missing=False):
        # Never inherit DOCKER_HOST, a user's CLI context or credential helpers.
        p = subprocess.Popen(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *args],
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env={'PATH': '/usr/bin:/bin', 'HOME': '/root'})
        try:
            import selectors
            output = bytearray()
            deadline = time.monotonic() + 8
            with selectors.DefaultSelector() as selector:
                selector.register(p.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    if time.monotonic() >= deadline:
                        raise TimeoutError('engine deadline')
                    for key, _ in selector.select(timeout=0.1):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        output.extend(chunk)
                        if len(output) > limit:
                            raise ValueError('engine output limit')
            p.wait(timeout=1)
            if p.returncode and not missing:
                raise RuntimeError('engine operation failed')
            return p.returncode, bytes(output)
        finally:
            if p.poll() is None:
                p.kill()
            p.wait(timeout=2)

    def inspect(self, name):
        # A daemon failure is NOT evidence that a container is absent.
        _, raw = self.docker('container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}')
        ids = raw.decode().split()
        if not ids:
            return None
        if len(ids) != 1:
            raise RuntimeError('ambiguous container')
        _, raw = self.docker('container', 'inspect', ids[0])
        c = json.loads(raw)[0]
        if c['Name'] != '/' + name or c['Config'].get('Labels', {}).get(LABEL) != self.policy['project']:
            raise RuntimeError('container ownership mismatch')
        return c

    def remove(self, name):
        c = self.inspect(name)
        if c is not None:
            self.docker('container', 'rm', '--force', c['Id'])
        if self.inspect(name) is not None:
            raise RuntimeError('cleanup unconfirmed')
        self.unpin(name)

    def anchor(self, name):
        return self.state / ('mount-' + name)

    def pin(self, name, fd):
        path = self.anchor(name)
        path.mkdir(mode=0o700)
        # runc rejects proc-fd bind sources. Resolve the protected open descriptor
        # into a root-owned host bind mount, then let Docker pin that mount.
        subprocess.run(['/usr/bin/mount', '--bind', f'/proc/{os.getpid()}/fd/{fd}', str(path)],
                       check=True, timeout=5, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       env={'PATH': '/usr/bin:/bin'})
        return path

    def unpin(self, name):
        path = self.anchor(name)
        if not path.exists():
            return
        mounts = [line.split()[4] for line in Path('/proc/self/mountinfo').read_text().splitlines()]
        if str(path) in mounts:
            subprocess.run(['/usr/bin/umount', str(path)], check=True, timeout=5,
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           env={'PATH': '/usr/bin:/bin'})
        path.rmdir()

    def run(self, raw):
        r = validate_request(raw)
        name = self.policy['project'] + '-command-' + r['commandId']
        file = self.state / (r['commandId'] + '.json')
        with (self.state / '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            saved = json.loads(file.read_text()) if file.exists() else None
            if r['operation'] == 'stop':
                # Durable tombstone first prevents a delayed start after cancel.
                atomic_json(file, {'status': 'stopped'})
                self.remove(name)
                return {'status': 'stopped'}
            if saved and saved['status'] == 'stopped':
                self.remove(name)
                return {'status': 'stopped'}
            if r['operation'] == 'start':
                digest = hashlib.sha256(json.dumps(r, sort_keys=True).encode()).hexdigest()
                if saved:
                    if saved.get('inputHash') != digest:
                        raise ValueError('command identity conflict')
                    # Never replay a start whose engine outcome was ambiguous.
                    return self.poll(name, file, saved)
                # One active command per admitted executor. No caller-selected
                # labels, image, mounts, environment, network or engine options.
                _, active = self.docker('container', 'ls', '--filter', 'label=' + LABEL + '=' + self.policy['project'], '--format', '{{.ID}}')
                if active.strip():
                    raise RuntimeError('executor busy')
                cwd = Path(self.policy['workspaceRoot']) / r['workspace']
                private_path(cwd, 1000, directory=True)
                parent = cwd.parent
                private_path(parent, 1000, directory=True)
                # Anchor the mount to an open directory, rather than re-resolve
                # a controller-writable path in the privileged Docker daemon.
                fd = os.open(cwd, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    if Path('/proc/self/fd/' + str(fd)).resolve() != cwd:
                        raise ValueError('workspace moved')
                    saved = {'status': 'reserved', 'inputHash': digest, 'deadline': time.time() + r['timeoutSeconds'] + 10}
                    atomic_json(file, saved)
                    anchor = self.pin(name, fd)
                    self.docker('container', 'create', '--name', name, '--label', LABEL + '=' + self.policy['project'],
                                '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
                                '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m',
                                '--memory-swap', '512m', '--cpus', '1', '--restart', 'no', '--stop-timeout', '1',
                                '--log-driver', 'json-file', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=1',
                                '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
                                '--mount', f'type=bind,src={anchor},dst=/work',
                                '--workdir', '/work', '--entrypoint', '/usr/bin/timeout', self.policy['image'],
                                '--signal=KILL', str(r['timeoutSeconds']) + 's',
                                'python3', '/usr/local/lib/verrail/repository-container-init.py',
                                base64.b64encode(r['command'].encode()).decode())
                    self.docker('container', 'start', name)
                    saved['status'] = 'running'
                    atomic_json(file, saved)
                finally:
                    os.close(fd)
                    self.unpin(name)
                return self.poll(name, file, saved)
            if not saved:
                raise ValueError('unknown command')
            return self.poll(name, file, saved)

    def poll(self, name, file, saved):
        if saved['status'] == 'finished':
            return saved['result']
        c = self.inspect(name)
        if c is None or saved['status'] == 'reserved':
            raise RuntimeError('ambiguous start; explicit stop required')
        if c['State']['Running']:
            if time.time() <= saved['deadline']:
                return {'status': 'running'}
            self.remove(name)
            result = {'status': 'finished', 'exitCode': 1, 'stdout': '', 'stderr': '', 'error': 'timeout'}
        else:
            result = {'status': 'finished', 'exitCode': 1, 'stdout': '', 'stderr': '', 'error': 'execution_failed'}
            if c['State']['ExitCode'] in (124, 137):
                result['error'] = 'timeout'
            else:
                try:
                    _, output = self.docker('container', 'logs', name, limit=2*LIMIT)
                    data = json.loads(output)
                    if set(data) - {'exitCode', 'stdout', 'stderr', 'error'} or type(data['exitCode']) is not int:
                        raise ValueError('invalid output')
                    if not isinstance(data['stdout'], str) or not isinstance(data['stderr'], str):
                        raise ValueError('invalid output')
                    if data.get('error') not in (None, 'output_limit'):
                        raise ValueError('invalid output')
                    if len(data['stdout'].encode()) + len(data['stderr'].encode()) > LIMIT:
                        data = {'exitCode': 1, 'stdout': '', 'stderr': '', 'error': 'output_limit'}
                    result = {'status': 'finished', **data}
                except (ValueError, KeyError, TypeError):
                    pass
            self.remove(name)
        saved.update(status='finished', result=result)
        atomic_json(file, saved)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', type=Path, default=Path('/opt/maco-ops/apps/verrail/test/container-policy.json'))
    args = parser.parse_args()
    if os.geteuid() != 0 or sys.platform != 'linux':
        raise ValueError('requires authorized Linux operations identity')
    if os.environ.get('SSH_ORIGINAL_COMMAND', 'verrail-container-v1') != 'verrail-container-v1':
        raise ValueError('command not allowed')
    # Bound slow input/lock waits too. An interrupted engine request remains
    # unresolved; a later stop uses its durable command identity for recovery.
    signal.alarm(30)
    os.umask(0o077)
    raw = sys.stdin.buffer.read(512*1024 + 1)
    if len(raw) > 512*1024:
        raise ValueError('request too large')
    print(json.dumps(Gateway(load_policy(args.policy)).run(json.loads(raw))))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Repository container operation failed', file=sys.stderr)
        sys.exit(1)
