#!/usr/bin/python3
"""Owner-authorized, first-install-only Verrail test command gateway.

Run from a reviewed root-owned source directory. Refuses existing identities,
policy, helper, credentials, or nonempty scratch. Does not provision databases,
change sshd/network settings, or start an application service.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import tempfile

OPS = Path('/opt/maco-ops/apps/verrail/test')
SECRETS = Path('/opt/maco-ops/secrets/verrail/test/runtime')
WORK = Path('/opt/maco-apps/verrail/test/data/repository/workspaces')
HELPER = Path('/usr/local/sbin/verrail-container-gateway')
HOME = Path('/var/lib/verrail-command')
SUDOERS = Path('/etc/sudoers.d/verrail-command')
ACCOUNT = 'verrail-command'


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


def write(path, content, mode=0o600, uid=0):
    with path.open('x') as f:
        f.write(content)
    os.chmod(path, mode)
    os.chown(path, uid, uid)


def directory(path, mode=0o700, uid=0):
    if path.exists():
        s = path.lstat()
        if path.is_symlink() or not path.is_dir() or s.st_uid != uid or s.st_mode & 0o777 != mode:
            raise RuntimeError('existing directory ownership/mode mismatch: ' + str(path))
    else:
        path.mkdir(mode=mode, parents=True)
        os.chown(path, uid, uid)
        os.chmod(path, mode)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--resume-prepared', action='store_true',
                        help='Resume an inspected policy/scratch-only install; never overwrites an identity')
    args = parser.parse_args()
    assert os.geteuid() == 0 and os.uname().machine == 'x86_64'
    assert re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}', args.image)
    os.umask(0o077)
    source = Path(__file__).resolve().parent
    for name in ['repository-container-gateway.py', 'repository-container-native.py']:
        s = (source/name).stat()
        assert s.st_uid == 0 and s.st_mode & 0o022 == 0
    report = json.loads(run(['/usr/bin/python3', '/opt/maco-ops/bin/inspect_server.py']))
    assert report['ok'], 'platform inspection failed'
    info = json.loads(run(['/usr/bin/docker', 'image', 'inspect', args.image]))[0]
    assert info['Architecture'] == 'amd64' and info['Os'] == 'linux'
    try:
        pwd.getpwnam(ACCOUNT)
    except KeyError:
        pass
    else:
        raise RuntimeError('identity already exists; inspect receipt, do not overwrite')
    for path in [HELPER, HOME, SUDOERS, SECRETS/'container-runner-key',
                 SECRETS/'container-runner.json', SECRETS/'container-runner-known-hosts']:
        assert not path.exists() and not path.is_symlink(), 'existing resource: ' + str(path)
    directory(OPS)
    directory(OPS/'container-commands')
    policy = {'project': 'verrail-test', 'image': args.image, 'workspaceRoot': str(WORK),
              'stateRoot': str(OPS/'container-commands')}
    if args.resume_prepared:
        assert json.loads((OPS/'container-policy.json').read_text()) == policy
        assert not any(WORK.iterdir()), 'scratch is not empty'
    else:
        assert not WORK.exists(), 'scratch already exists; explicit review required'
        assert not (OPS/'container-policy.json').exists(), 'policy exists; explicit review required'
        directory(WORK.parent, uid=1000)
        directory(WORK, uid=1000)
        run(['/usr/bin/mount', '-t', 'tmpfs', '-o', 'size=512m,uid=1000,gid=1000,mode=0700,nosuid,nodev',
             'verrail-command-scratch', str(WORK)])
        write(OPS/'container-policy.json', json.dumps(policy))
    native = json.loads(run(['/usr/bin/python3', str(source/'repository-container-native.py')]))
    assert native['status'] == 'passed'
    write(OPS/'container-native-receipt.json', json.dumps(native, indent=2)+'\n')

    # Enable the dedicated identity only after real-container checks pass.
    directory(SECRETS.parent)
    directory(SECRETS)
    run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir', str(HOME),
         '--shell', '/bin/sh', ACCOUNT])
    directory(HOME, mode=0o755)
    directory(HOME/'.ssh', mode=0o755)
    write(HELPER, (source/'repository-container-gateway.py').read_text(), mode=0o755)
    sudo = f'{ACCOUNT} ALL=(root) NOPASSWD: {HELPER} ""\n'
    with tempfile.NamedTemporaryFile(mode='w', dir='/etc/sudoers.d', prefix='.verrail-check-') as candidate:
        candidate.write(sudo)
        candidate.flush()
        run(['/usr/sbin/visudo', '-cf', candidate.name])
    write(SUDOERS, sudo, mode=0o440)
    run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'verrail-test-command',
         '-f', str(SECRETS/'container-runner-key')])
    os.chown(SECRETS/'container-runner-key', 1000, 1000)
    public = (SECRETS/'container-runner-key.pub').read_text().strip()
    write(HOME/'.ssh/authorized_keys', f'restrict,command="sudo -n {HELPER}" {public}\n', mode=0o644)
    host_public = Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()
    write(SECRETS/'container-runner-known-hosts', '192.168.31.93 '+' '.join(host_public[:2])+'\n', uid=1000)
    write(SECRETS/'container-runner.json', json.dumps({'destination': ACCOUNT+'@192.168.31.93', 'port': 22,
          'identityFile': '/run/secrets/container-runner-key',
          'knownHostsFile': '/run/secrets/container-runner-known-hosts'}), uid=1000)
    run(['/usr/sbin/sshd', '-t'])
    receipt = {'image': args.image, 'account': ACCOUNT, 'helper': str(HELPER),
               'helperSha256': hashlib.sha256(HELPER.read_bytes()).hexdigest(),
               'policySha256': hashlib.sha256((OPS/'container-policy.json').read_bytes()).hexdigest(),
               'native': native, 'backupVerification': 'not_performed',
               'sshTransport': 'not_yet_verified', 'sevenServiceAcceptance': 'not_performed',
               'scratchPersistence': 'manual mount; restart fails closed after host reboot'}
    write(OPS/'container-gateway-install.json', json.dumps(receipt, indent=2)+'\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
