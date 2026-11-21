"""Synthetic SIP only, no sockets, providers, credentials or paid models."""
import os
import sys
from pathlib import Path
import threading
import time
import unittest
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).parents[1] / 'bridge'))
from inbound_routing import InboundPolicy, VerifiedBinding
from inbound_service import InboundService

SIP = ('INVITE sip:+34999999001@sip.example.invalid SIP/2.0\r\n'
       'Via: SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-test\r\n'
       'From: <sip:untrusted@192.0.2.1>;tag=caller\r\n'
       'To: <sip:+34999999001@sip.example.invalid>\r\n'
       'Contact: <sip:untrusted@192.0.2.1:5060>\r\n'
       'Call-ID: fixture-call\r\nCSeq: 1 INVITE\r\nContent-Length: 55\r\n\r\n'
       'v=0\r\nc=IN IP4 192.0.2.2\r\nm=audio 4000 RTP/AVP 8\r\n')

def policy():
    return InboundPolicy('fixture','fixture',(('192.0.2.1',5060),),('sip.example.invalid',),
        (VerifiedBinding('+34999999001','11111111-1111-4111-8111-111111111111','verified',int(time.time())+600,True),),
        'network-fixture',int(time.time())+600,True)

class Bridge:
    def __init__(self):
        self.pilot=False;self.call_lock=threading.RLock();self.call_active=False;self.enabled=True
        self.sip_user='synthetic';self.public_ip=None;self.local_ip='192.0.2.3';self.public_sip_port=None;self.sip_port=5082;self.cseq=1
        self.messages=[];self.started=0;self.ended=0
    def calls_enabled(self): return self.enabled
    def reply_sip(self,status,msg,peer): self.messages.append('SIP/2.0 '+status)
    def send_sip(self,msg,peer): self.messages.append(msg)
    def build_sdp(self): return 'v=0\r\n'
    def prime_rtp_nat(self): pass
    def notify_node_call_start(self): self.started+=1
    def reset_call(self): self.call_active=False;self.ended+=1

def wait_for(condition):
    limit=time.monotonic()+2
    while not condition():
        if time.monotonic()>limit: raise AssertionError('fixture deadline')
        time.sleep(.005)

class Inbound(unittest.TestCase):
    def setUp(self):
        os.environ['INBOUND_CONTROL_TOKEN']='s'*43
        self.bridge=Bridge();self.requests=[];self.ready=threading.Event()
        def request(route,body):
            self.requests.append((route,body))
            if route=='/prepare':
                self.ready.wait(1)
                return {'sessionId':body['dialogKey'],'maxSeconds':120}
            return {'confirmed':True}
        self.service=InboundService(self.bridge,policy(),['192.0.2.2'],request)
    def tearDown(self): self.ready.set()
    def invite(self): self.service.handle(SIP,('192.0.2.1',5060))
    def answer(self):
        self.invite();self.ready.set();wait_for(lambda: self.service.dialog and self.service.dialog['state']=='answered')
    def test_no_200_before_backend_and_engine_ready(self):
        self.invite();self.assertEqual(self.bridge.messages,['SIP/2.0 180 Ringing'])
        self.assertEqual(self.bridge.started,0);self.ready.set()
        wait_for(lambda:len(self.bridge.messages)>1)
        self.assertTrue(self.bridge.messages[-1].startswith('SIP/2.0 200'))
        self.assertGreater(self.bridge.call_started_at,0)
    def test_ack_starts_engine_only_once_and_bye_confirms_terminal(self):
        self.answer();d=self.service.dialog
        ack=SIP.replace('INVITE sip:','ACK sip:',1).replace('CSeq: 1 INVITE','CSeq: 1 ACK').replace('To: <sip:+34999999001@sip.example.invalid>','To: <sip:+34999999001@sip.example.invalid>;tag='+d['local_tag'])
        self.service.handle(ack,('192.0.2.1',5060));self.service.handle(ack,('192.0.2.1',5060))
        self.assertEqual(self.bridge.started,1);self.assertTrue(self.bridge.call_established)
        bye=ack.replace('ACK sip:','BYE sip:',1).replace('CSeq: 1 ACK','CSeq: 2 BYE')
        self.service.handle(bye,('192.0.2.1',5060));wait_for(lambda: any(r[0]=='/terminal' for r in self.requests))
        self.assertFalse(self.bridge.call_active)
    def test_untrusted_peer_and_sdp_never_reach_backend(self):
        self.service.handle(SIP,('192.0.2.99',5060))
        self.service.handle(SIP.replace('192.0.2.2\r\n','192.0.2.99\r\n'),('192.0.2.1',5060))
        self.assertEqual(self.requests,[]);self.assertFalse(self.bridge.call_active)
    def test_cancel_during_prepare_never_answers_late(self):
        self.invite();self.service.handle(SIP.replace('INVITE sip:','CANCEL sip:',1).replace('CSeq: 1 INVITE','CSeq: 1 CANCEL'),('192.0.2.1',5060))
        self.ready.set();wait_for(lambda:any(r[0]=='/terminal' for r in self.requests))
        self.assertIsNone(self.service.dialog)
        self.assertFalse(any(m.startswith('SIP/2.0 200 OK\r\n') for m in self.bridge.messages))
    def test_timeout_sends_bye_and_retains_slot_until_confirmation(self):
        self.answer();d=self.service.dialog;d['started']=time.monotonic()-121
        self.service.tick();self.assertEqual(d['state'],'ending');self.assertTrue(self.bridge.call_active)
        self.assertTrue(any(m.startswith('BYE ') for m in self.bridge.messages))
    def test_off_and_second_dialog_are_rejected(self):
        self.bridge.enabled=False;self.invite();self.assertEqual(self.requests,[])
        self.bridge.enabled=True;self.invite();self.service.handle(SIP.replace('fixture-call','another-call'),('192.0.2.1',5060))
        self.assertEqual(self.bridge.messages[-1],'SIP/2.0 486 Busy Here')

if __name__=='__main__':unittest.main()
