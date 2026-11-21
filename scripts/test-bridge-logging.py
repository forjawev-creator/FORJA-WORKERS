"""Pure diagnostic redaction tests; no bridge startup or communications."""
import ast
from pathlib import Path
import re
import unittest

source = Path(__file__).parents[1] / 'bridge' / 'netelip-bridge.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
namespace = {'re': re}
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'sip_log_summary')
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
summary = namespace['sip_log_summary']

class LogPrivacy(unittest.TestCase):
    def test_requests_never_include_destination_or_headers(self):
        for method in ['INVITE', 'BYE', 'REGISTER', 'REFER']:
            self.assertEqual(summary(method + ' sip:+34999999001@example.invalid SIP/2.0\r\nAuthorization: secret'), 'request ' + method)

    def test_responses_never_include_reason_or_headers(self):
        self.assertEqual(summary('SIP/2.0 403 Empresa ficticia +34999999001 Authorization: secret'), 'response 403')
        self.assertEqual(summary('SIP/2.0 200 OK'), 'response 200')

    def test_unknown_messages_do_not_echo_input(self):
        for value in ['Authorization: secret', '+34999999001', 'Empresa ficticia', 'SIP/2.0 invalid', '']:
            self.assertEqual(summary(value), 'unrecognized_message')

    def test_dynamic_print_values_are_allowlisted(self):
        allowed = {'self.sip_port', 'self.rtp_port', 'self.leg2_rtp_port',
                   'self.active_segment.turn_id', 'seg.turn_id', 'played_ms', 'starve_count',
                   'starve_ms', 'CONTROL_UDP_PORT', 'self.registered', 'self.call_active',
                   'type(e).__name__', 'sip_log_summary(first_line)'}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'print':
                for arg in node.args:
                    if isinstance(arg, ast.JoinedStr):
                        for part in arg.values:
                            if isinstance(part, ast.FormattedValue):
                                self.assertIn(ast.unparse(part.value), allowed)
                    else:
                        self.assertIsInstance(arg, ast.Constant)

if __name__ == '__main__': unittest.main()
