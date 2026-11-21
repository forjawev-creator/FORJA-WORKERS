"""Synthetic SIP -> real loopback HTTP/TCP. Never opens a SIP/RTP/provider socket.

stdin JSON contains synthetic routing values and loopback control token/ports.
The test engine should request completed hangup after its backend tool work.
"""
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import sys
import time
import http.client

spec = importlib.util.spec_from_file_location('sip_fixture', Path(__file__).with_name('test-inbound-service.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
config = json.load(sys.stdin)
os.environ['INBOUND_CONTROL_TOKEN'] = config['token']
peer = ('192.0.2.1', 5060)
audio = socket.create_connection(('127.0.0.1', config['audioPort']), timeout=20)
def packet(kind, body=b''):
    audio.sendall(struct.pack('!BBH', kind, 0, len(body)) + body)
packet(8, config['token'].encode())
def request(route, body):
    conn = http.client.HTTPConnection('127.0.0.1', config['controlPort'], timeout=20)
    try:
        conn.request('POST', route, json.dumps(body), {'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
        response = conn.getresponse()
        data = json.loads(response.read(65536))
        if response.status != 200:
            raise RuntimeError('fixture_control_unconfirmed')
        return data
    finally:
        conn.close()
class TransportBridge(fixture.Bridge):
    def notify_node_call_start(self):
        super().notify_node_call_start()
        packet(4,json.dumps({'sessionId':self.session_id,'codec':'pcma','direction':'inbound'}).encode())
        packet(1,bytes([0xd5])*160)
    def reset_call(self):
        packet(5,json.dumps({'sessionId':self.session_id,'reason':'hangup'}).encode())
        super().reset_call()
policy=fixture.InboundPolicy('fixture','fixture',(peer,),('sip.example.invalid',),
    (fixture.VerifiedBinding(config['destination'],config['installation'],'synthetic-verification',int(time.time())+600,True),),
    'synthetic-network',int(time.time())+600,True)
b=TransportBridge()
gate=fixture.InboundService(b,policy,['192.0.2.2'],request)
invite=fixture.SIP.replace('+34999999001',config['destination'])
time.sleep(.05) # allow the authenticated TCP frame to reach the Node listener
gate.handle(invite,peer)
deadline=time.monotonic()+20
while not gate.dialog or gate.dialog['state']!='answered':
    if time.monotonic()>deadline: raise RuntimeError('fixture_no_admission')
    time.sleep(.01)
d=gate.dialog
ack=invite.replace('INVITE sip:','ACK sip:',1).replace('CSeq: 1 INVITE','CSeq: 1 ACK').replace('To: <sip:'+config['destination']+'@sip.example.invalid>','To: <sip:'+config['destination']+'@sip.example.invalid>;tag='+d['local_tag'])
gate.handle(ack,peer)
def exact(size):
    result=b''
    while len(result)<size:
        value=audio.recv(size-len(result))
        if not value: raise RuntimeError('fixture_audio_closed')
        result+=value
    return result
while True:
    kind,turn,size=struct.unpack('!BBH',exact(4))
    payload=exact(size)
    if kind==5:
        command=json.loads(payload)
        if command['sessionId']!=d['key']: raise RuntimeError('fixture_dialog_mismatch')
        d['completion']='finalizada' if command.get('reason')=='completed' else 'interrumpida'
        gate.hangup()
        response='SIP/2.0 200 OK\r\nCall-ID: '+d['call_id']+'\r\nCSeq: '+d['bye_cseq']+'\r\n\r\n'
        gate.handle(response,peer)
        break
while gate.terminal_pending:
    if time.monotonic()>deadline: raise RuntimeError('fixture_terminal_unconfirmed')
    time.sleep(.01)
audio.close()
print(json.dumps({'syntheticSip':True,'realSipSockets':False,'started':b.started,'ended':b.ended,
    'provisionalBeforeAnswer':b.messages[0].startswith('SIP/2.0 180') and b.messages[1].startswith('SIP/2.0 200'),
    'terminalConfirmed':not gate.terminal_pending}))
