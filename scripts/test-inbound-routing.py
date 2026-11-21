"""Pure routing tests; never opens sockets or calls provider/backend APIs."""
import dataclasses
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from inbound_routing import InboundPolicy, VerifiedBinding, RoutingRejected, resolve_inbound


class InboundRouting(unittest.TestCase):
    def setUp(self):
        self.a=VerifiedBinding('+34900000001','11111111-1111-4111-8111-111111111111','fixture-a',2000,True)
        self.b=VerifiedBinding('+34900000002','22222222-2222-4222-8222-222222222222','fixture-b',2000,True)
        self.policy=InboundPolicy('fixture-listener','fixture-provider',(('192.0.2.1',5060),),('gateway.invalid',),(self.a,self.b),'fixture-network',2000,True)

    def invite(self, destination='+34900000001', extra=''):
        return f'INVITE sip:{destination}@gateway.invalid SIP/2.0\r\nCall-ID: synthetic-call\r\nCSeq: 1 INVITE\r\n{extra}\r\n'

    def resolve(self, message=None, **changes):
        args=dict(peer_ip='192.0.2.1',peer_port=5060,listener_id='fixture-listener',policy=self.policy,now=1000)
        args.update(changes)
        return resolve_inbound(message or self.invite(),**args)

    def test_disabled_by_default(self):
        with self.assertRaisesRegex(RoutingRejected,'inbound_disabled'):
            self.resolve(policy=InboundPolicy('fixture-listener','fixture-provider'))

    def test_two_installations_resolve_independently(self):
        a=self.resolve();b=self.resolve(self.invite('+34900000002'))
        self.assertEqual(a.installation_id,self.a.installation_id)
        self.assertEqual(b.installation_id,self.b.installation_id)
        self.assertNotEqual(a.dialog_key,b.dialog_key)
        self.assertFalse(a.caller_authenticated)
        self.assertEqual(a.trust_scope,'routing_only')

    def test_retransmission_same_key_and_normalized_number(self):
        self.assertEqual(self.resolve().dialog_key,self.resolve(self.invite('34900000001')).dialog_key)

    def test_peer_address_port_and_listener_must_match(self):
        for change in [dict(peer_ip='192.0.2.99'),dict(peer_port=5099),dict(listener_id='other')]:
            with self.assertRaises(RoutingRejected):self.resolve(**change)

    def test_caller_headers_never_select_installation(self):
        extra='From: <sip:+34900000002@caller.invalid>\r\nTo: <sip:+34900000002@gateway.invalid>\r\nDiversion: <sip:+34900000002@caller.invalid>\r\nX-Installation-ID: '+self.b.installation_id+'\r\n'
        self.assertEqual(self.resolve(self.invite(extra=extra)).installation_id,self.a.installation_id)

    def test_unknown_destination_does_not_fallback_to_header(self):
        with self.assertRaisesRegex(RoutingRejected,'unknown_destination'):
            self.resolve(self.invite('+34900000009','To: <sip:+34900000001@gateway.invalid>\r\n'))

    def test_encoded_malformed_or_ambiguous_uri_rejected(self):
        for value in ['%2B34900000001','34900000001;evil','34900000001?x=1','anonymous']:
            with self.assertRaises(RoutingRejected):self.resolve(self.invite(value))
        with self.assertRaises(RoutingRejected):self.resolve(self.invite().replace('gateway.invalid','attacker.invalid'))

    def test_duplicate_binding_rejected(self):
        with self.assertRaisesRegex(RoutingRejected,'ambiguous_destination_mapping'):
            dataclasses.replace(self.policy,bindings=(self.a,dataclasses.replace(self.b,destination=self.a.destination)))

    def test_duplicate_call_id_including_compact_header_rejected(self):
        for extra in ['Call-ID: second\r\n','i: second\r\n','CSeq: 2 INVITE\r\n']:
            with self.assertRaisesRegex(RoutingRejected,'ambiguous_sip_transaction'):
                self.resolve(self.invite(extra=extra))

    def test_inactive_unverified_expired_bindings_rejected(self):
        for changes in [dict(active=False),dict(verification_id=''),dict(verified_until=999)]:
            policy=dataclasses.replace(self.policy,bindings=(dataclasses.replace(self.a,**changes),))
            with self.assertRaises(RoutingRejected):self.resolve(policy=policy)

    def test_expired_network_verification_rejected(self):
        with self.assertRaises(RoutingRejected):self.resolve(now=2000)

    def test_error_does_not_disclose_destination(self):
        with self.assertRaises(RoutingRejected) as result:self.resolve(self.invite('+34900000009'))
        self.assertNotIn('34900000009',str(result.exception))

if __name__=='__main__':unittest.main()
