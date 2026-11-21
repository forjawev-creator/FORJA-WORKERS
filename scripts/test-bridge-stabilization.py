"""Isolated bridge methods: no module startup, numpy, credentials or network."""
import ast
import json
import os
from pathlib import Path
import re
import threading
from types import SimpleNamespace
import unittest

source = Path(__file__).resolve().parents[1] / 'bridge/netelip-bridge.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
original = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'NetelipSipBridge')
selected = {'calls_enabled', 'require_calls_enabled', 'registration_valid', 'handle_register_response', 'send_register', 'send_rtp_frame', 'reset_rtp_metrics', 'validate_destination'}
cls = ast.ClassDef(name='Bridge', bases=[], keywords=[], body=[n for n in original.body if isinstance(n, ast.FunctionDef) and n.name in selected], decorator_list=[])
clock = SimpleNamespace(time=lambda: 1000, monotonic=lambda: 1000, perf_counter=lambda: 1000, sleep=lambda _: None)
ns = {'os': os, 'json': json, 're': re, 'time': clock}
exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])), str(source), 'exec'), ns)
Bridge = ns['Bridge']

class Stabilization(unittest.TestCase):
    def setUp(self):
        self.b = Bridge()
        self.b.register_transaction = (12, 'registration-test', 'branch-test', False)
        self.b.registered = True
        self.b.register_expires_at = 1060
        self.b.register_error = ''

    def response(self, status='200 OK', cseq=12, call_id='registration-test', branch='branch-test', expires=30):
        return f'SIP/2.0 {status}\r\nVia: SIP/2.0/UDP localhost;branch={branch}\r\nCall-ID: {call_id}\r\nCSeq: {cseq} REGISTER\r\nExpires: {expires}\r\n\r\n'

    def test_rejection_invalidates_previous_success(self):
        self.b.handle_register_response(self.response('403 Forbidden'))
        self.assertFalse(self.b.registered)
        self.assertEqual(self.b.register_error, 'rejected_403')

    def test_expiry_is_checked_on_status(self):
        self.b.register_expires_at = 999
        self.assertFalse(self.b.registration_valid())
        self.assertEqual(self.b.register_error, 'expired')

    def test_success_sets_monotonic_expiry(self):
        self.b.handle_register_response(self.response())
        self.assertEqual(self.b.register_expires_at, 1030)
        self.assertTrue(self.b.registration_valid())

    def test_unmatched_transaction_does_not_change_state(self):
        for kwargs in ({'cseq': 11}, {'call_id': 'other'}, {'branch': 'other'}):
            self.b.handle_register_response(self.response('403 Forbidden', **kwargs))
            self.assertTrue(self.b.registered)
            self.assertIsNotNone(self.b.register_transaction)

    def test_zero_expiry_unregisters(self):
        self.b.handle_register_response(self.response(expires=0))
        self.assertFalse(self.b.registered)

    def test_no_pending_transaction_ignores_success(self):
        self.b.registered = False
        self.b.register_transaction = None
        self.b.handle_register_response(self.response())
        self.assertFalse(self.b.registered)

    def test_authenticated_challenge_does_not_loop(self):
        self.b.register_transaction = (12, 'registration-test', 'branch-test', True)
        self.b.handle_register_response(self.response('401 Unauthorized'))
        self.assertFalse(self.b.registered)
        self.assertEqual(self.b.register_error, 'authentication_rejected')

    def test_missing_runtime_policy_blocks_direct_execution(self):
        self.b.config_path = str(Path(__file__).parent / 'nonexistent-test-directory/config.json')
        with self.assertRaises(RuntimeError):
            self.b.require_calls_enabled()

    def test_destination_guard_preserved(self):
        self.b.pilot = True
        self.b.allowed_numbers = {'34900000000'}
        self.assertEqual(self.b.validate_destination('+34900000000'), '34900000000')
        with self.assertRaises(ValueError):
            self.b.validate_destination('34900000001')

    def test_packet_success_failure_and_per_call_reset(self):
        b = self.b
        b.rtp_send_lock = threading.Lock()
        b.call_active = True
        b.remote_rtp_ip, b.remote_rtp_port = '192.0.2.1', 40000
        b.rtp_seq = b.rtp_timestamp = b.rtp_ssrc = 1
        b.last_actual_rtp_send_time = 0
        b.rtp_totals = dict(sent=0, received=0, send_errors=0, receive_errors=0)
        b.reset_rtp_metrics()
        sent = []
        b.rtp_sock = SimpleNamespace(sendto=lambda data, addr: sent.append(data))
        self.assertTrue(b.send_rtp_frame(b'\xd5' * 160))
        self.assertEqual((b.rtp_packets_sent, b.rtp_totals['sent'], len(sent)), (1, 1, 1))
        def fail(*args):
            raise OSError('simulated transport failure')
        b.rtp_sock.sendto = fail
        self.assertFalse(b.send_rtp_frame(b'\xd5' * 160))
        self.assertEqual((b.rtp_send_errors, b.rtp_totals['send_errors']), (1, 1))
        b.reset_rtp_metrics()
        self.assertEqual((b.rtp_packets_sent, b.rtp_send_errors), (0, 0))
        self.assertEqual((b.rtp_totals['sent'], b.rtp_totals['send_errors']), (1, 1))

if __name__ == '__main__':
    unittest.main()
