import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('container_gateway', Path(__file__).with_name('repository-container-gateway.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class FakeGateway(gateway.Gateway):
    def pin(self, name, fd):
        return self.anchor(name)

    def unpin(self, name):
        if getattr(self, 'fail_unpin', False):
            raise RuntimeError('mount cleanup unconfirmed')

    def __init__(self, policy):
        super().__init__(policy)
        self.calls = []
        self.container = None
        self.fail_remove = False
        self.output = json.dumps({'exitCode': 0, 'stdout': 'ok', 'stderr': ''}).encode()

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        if args[:2] == ('container', 'ls'):
            if '--format' in args and any(a.startswith('label=') for a in args):
                return 0, b'container' if self.container and self.container['State']['Running'] else b''
            return 0, b'container' if self.container else b''
        if args[:2] == ('container', 'inspect'):
            return 0, json.dumps([self.container]).encode()
        if args[:2] == ('container', 'create'):
            name = args[args.index('--name') + 1]
            self.container = {'Name': '/' + name, 'Id': 'container',
                              'Config': {'Labels': {gateway.LABEL: self.policy['project']}},
                              'State': {'Running': False, 'ExitCode': 0}}
            return 0, b'container'
        if args[:2] == ('container', 'start'):
            self.container['State']['Running'] = True
            return 0, b'container'
        if args[:2] == ('container', 'rm'):
            if self.fail_remove:
                raise RuntimeError('engine unavailable')
            self.container = None
            return 0, b'container'
        if args[:2] == ('container', 'logs'):
            return 0, self.output
        raise AssertionError(args)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root/'state').mkdir()
        (root/'work'/'verrail-repository-fixture'/'checkout').mkdir(parents=True)
        self.g = FakeGateway({'project': 'verrail-test', 'stateRoot': str(root/'state'),
                              'workspaceRoot': str(root/'work'), 'image': 'fixture@sha256:'+'a'*64})
        self.request = {'version': 1, 'operation': 'start', 'commandId': str(uuid.uuid4()),
                        'workspace': 'verrail-repository-fixture/checkout', 'command': 'printf ok', 'timeoutSeconds': 5}
        # Linux O_PATH/proc pinning is covered by the native fixture. Unit tests
        # run on macOS too, without granting any real engine or root access.
        self.patch(gateway, 'private_path', lambda *args, **kwargs: None)
        self.patch(gateway.os, 'open', self.fake_open)
        self.patch(gateway.Path, 'resolve', self.resolve)
        self.patch(gateway.os, 'O_PATH', getattr(os, 'O_PATH', 0), create=True)

    real_open = staticmethod(os.open)
    real_resolve = Path.resolve

    def fake_open(self, path, flags, *args, **kwargs):
        if str(path).endswith('/checkout'):
            return self.real_open(path, os.O_RDONLY | os.O_DIRECTORY)
        return self.real_open(path, flags, *args, **kwargs)

    def resolve(self, *args, **kwargs):
        return Path(self.g.policy['workspaceRoot']) / self.request['workspace']

    def patch(self, target, attr, value, **kwargs):
        p = patch.object(target, attr, value, **kwargs)
        p.start()
        self.addCleanup(p.stop)

    def packet(self, operation):
        return {k: self.request[k] for k in ['version', 'commandId']} | {'operation': operation}

    def test_start_is_fixed_offline_least_privilege_and_idempotent(self):
        self.assertEqual(self.g.run(self.request), {'status': 'running'})
        self.assertEqual(self.g.run(self.request), {'status': 'running'})
        calls = [c for c in self.g.calls if c[:2] == ('container', 'create')]
        self.assertEqual(len(calls), 1)
        c = calls[0]
        for option, value in [('--network','none'), ('--user','1000:1000'), ('--cap-drop','ALL'),
                              ('--security-opt','no-new-privileges'), ('--pids-limit','64'), ('--restart','no')]:
            self.assertEqual(c[c.index(option)+1], value)
        self.assertIn('--read-only', c)
        self.assertEqual(sum(v == '--mount' for v in c), 1)
        self.assertNotIn('--privileged', c)
        self.assertNotIn('--env', c)

    def test_stop_before_start_tombstones_delayed_work(self):
        self.assertEqual(self.g.run(self.packet('stop')), {'status': 'stopped'})
        self.assertEqual(self.g.run(self.request), {'status': 'stopped'})
        self.assertFalse(any(c[:2] == ('container','create') for c in self.g.calls))

    def test_identity_conflict_cannot_execute_again(self):
        self.g.run(self.request)
        with self.assertRaises(ValueError):
            self.g.run(self.request | {'command': 'different'})

    def test_stop_confirms_engine_deletion_not_just_a_marker(self):
        self.g.run(self.request)
        self.g.fail_remove = True
        with self.assertRaises(RuntimeError):
            self.g.run(self.packet('stop'))
        self.assertIsNotNone(self.g.container)
        self.g.fail_remove = False
        self.assertEqual(self.g.run(self.packet('stop')), {'status': 'stopped'})
        self.assertIsNone(self.g.container)

    def test_stop_requires_temporary_host_mount_cleanup(self):
        self.g.run(self.request)
        self.g.fail_unpin = True
        with self.assertRaises(RuntimeError):
            self.g.run(self.packet('stop'))
        self.g.fail_unpin = False
        self.assertEqual(self.g.run(self.packet('stop')), {'status': 'stopped'})

    def test_finished_output_is_persisted_after_container_cleanup(self):
        self.g.run(self.request)
        self.g.container['State']['Running'] = False
        result = self.g.run(self.packet('poll'))
        self.assertEqual(result, {'status': 'finished', 'exitCode': 0, 'stdout': 'ok', 'stderr': ''})
        self.assertIsNone(self.g.container)
        self.assertEqual(self.g.run(self.request), result)

    def test_unknown_poll_does_not_start(self):
        with self.assertRaises(ValueError):
            self.g.run(self.packet('poll'))

    def test_foreign_label_prevents_destruction(self):
        self.g.run(self.request)
        self.g.container['Config']['Labels'][gateway.LABEL] = 'another-project'
        with self.assertRaises(RuntimeError):
            self.g.run(self.packet('stop'))
        self.assertIsNotNone(self.g.container)

    def test_malformed_output_is_failure_not_success(self):
        self.g.run(self.request)
        self.g.container['State']['Running'] = False
        self.g.output = b'not a result'
        self.assertEqual(self.g.run(self.packet('poll'))['error'], 'execution_failed')
        self.assertIsNone(self.g.container)

    def test_timeout_removes_container(self):
        self.g.run(self.request)
        with patch.object(gateway.time, 'time', return_value=10**15):
            self.assertEqual(self.g.run(self.packet('poll'))['error'], 'timeout')
        self.assertIsNone(self.g.container)

    def test_untrusted_fields_paths_and_limits_are_rejected(self):
        for changes in [{'workspace':'../secrets'}, {'workspace':'verrail-repository-x/checkout/..'},
                        {'image':'host-image'}, {'command':'\0'}, {'timeoutSeconds':121},
                        {'timeoutSeconds':True}, {'operation':'exec'}, {'version':True}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                gateway.validate_request(self.request | changes)

    def test_reserved_start_is_not_replayed_after_gateway_interruption(self):
        gateway.atomic_json(Path(self.g.policy['stateRoot'])/(self.request['commandId']+'.json'),
                            {'status':'reserved', 'inputHash':gateway.hashlib.sha256(json.dumps(self.request,sort_keys=True).encode()).hexdigest()})
        with self.assertRaises(RuntimeError):
            self.g.run(self.request)
        self.assertFalse(any(c[:2] == ('container','create') for c in self.g.calls))


if __name__ == '__main__':
    unittest.main()
