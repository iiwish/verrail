#!/usr/bin/python3
"""Explicit root-only native acceptance of an already admitted gateway policy.

Uses only a unique checkout and command IDs; no databases or application network.
The receipt is stdout JSON. Run after reviewing the command image and policy.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('repository-container-gateway.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


def main():
    policy = gateway.load_policy(Path('/opt/maco-ops/apps/verrail/test/container-policy.json'))
    g = gateway.Gateway(policy)
    root = Path(tempfile.mkdtemp(prefix='verrail-repository-native-', dir=policy['workspaceRoot']))
    cwd = root / 'checkout'
    cwd.mkdir(mode=0o700)
    for path in [root, cwd]:
        os.chown(path, 1000, 1000)
    packets = []
    checks = []

    def packet(command, timeout=5):
        r = {'version': 1, 'operation': 'start', 'commandId': str(uuid.uuid4()),
             'workspace': str(cwd.relative_to(policy['workspaceRoot'])),
             'command': command, 'timeoutSeconds': timeout}
        packets.append(r)
        return r

    def op(r, operation):
        return {'version': 1, 'operation': operation, 'commandId': r['commandId']}

    def completed(r):
        try:
            result = g.run(r)
        except RuntimeError:
            c = g.inspect(policy['project'] + '-command-' + r['commandId'])
            if c is not None:
                print(json.dumps({'nativeContainerStartError': c['State'].get('Error', '')}), file=sys.stderr)
            raise
        deadline = time.monotonic() + 30
        while result['status'] == 'running':
            assert time.monotonic() < deadline, 'fixture deadline'
            time.sleep(0.2)
            result = g.run(op(r, 'poll'))
        assert g.inspect(policy['project'] + '-command-' + r['commandId']) is None
        return result

    try:
        r = packet("printf once >> /work/proof; printf ok")
        result = completed(r)
        assert result == {'status': 'finished', 'exitCode': 0, 'stdout': 'ok', 'stderr': ''}, result
        assert g.run(r) == result and (cwd/'proof').read_text() == 'once'
        checks.append('write-output-idempotent-replay-confirmed-removal')

        r = packet("python3 -c \"import os,socket; assert os.getuid()==1000; assert not os.path.exists('/var/run/docker.sock'); assert not os.path.exists('/run/secrets'); assert not os.path.exists('/var/lib/verrail-artifacts'); assert not any('TOKEN' in k or 'PASSWORD' in k or 'DATABASE' in k for k in os.environ); assert set(os.listdir('/sys/class/net'))=={'lo'}; print('isolated')\"")
        assert completed(r)['stdout'] == 'isolated\n'
        checks.append('uid-offline-no-socket-no-credentials-no-artifact-store')

        r = packet("printf forbidden >/usr/local/forbidden", 5)
        assert completed(r)['exitCode'] != 0
        checks.append('read-only-root')

        r = packet("python3 -c \"print('x'*1100000)\"")
        assert completed(r)['error'] == 'output_limit'
        checks.append('bounded-output')

        r = packet('sleep 30', 1)
        assert completed(r)['error'] == 'timeout'
        checks.append('hard-container-deadline')

        r = packet("setsid /bin/sh -c 'sleep 3; printf leaked >/work/leaked' >/dev/null 2>&1 & sleep 30", 10)
        assert g.run(r)['status'] == 'running'
        assert g.run(r)['status'] == 'running'
        assert g.run(op(r, 'stop')) == {'status': 'stopped'}
        time.sleep(3.5)
        assert not (cwd/'leaked').exists()
        assert g.run(r) == {'status': 'stopped'}
        assert g.inspect(policy['project'] + '-command-' + r['commandId']) is None
        checks.append('cancel-kills-detached-descendant-and-tombstones-late-start')

        r = packet('printf never > /work/never')
        assert g.run(op(r, 'stop')) == {'status': 'stopped'}
        assert g.run(r) == {'status': 'stopped'} and not (cwd/'never').exists()
        checks.append('stop-before-start')
        print(json.dumps({'status': 'passed', 'kernel': os.uname().release,
                          'machine': os.uname().machine, 'image': policy['image'], 'checks': checks}))
    finally:
        # Keep gateway tombstones: deleting them could make a delayed start valid.
        for r in packets:
            g.run(op(r, 'stop'))
        shutil.rmtree(root)


if __name__ == '__main__':
    main()
