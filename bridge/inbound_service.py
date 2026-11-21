"""Inbound-only SIP admission. Disabled unless explicitly selected; no commercial routing.

The local control API is authenticated. SIP metadata is checked before contacting
the backend. The backend remains the authority for the destination's tenant.
"""
import http.client
import ipaddress
import json
import os
import re
import secrets
import threading
import time
from inbound_routing import InboundPolicy, VerifiedBinding, resolve_inbound


class InboundService:
    def __init__(self, bridge, policy=None, media_peers=None, request=None):
        self.bridge = bridge
        self.dialog = None
        self.terminal_pending = False
        self.terminal_key = None
        self.token = os.environ.get('INBOUND_CONTROL_TOKEN', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', self.token):
            raise ValueError('invalid_inbound_control_token')
        if bridge.pilot:
            raise ValueError('inbound_and_pilot_are_exclusive')
        if policy is None:
            with open(os.path.join(os.path.dirname(bridge.config_path), 'inbound-routing.json'), encoding='utf-8') as stream:
                config = json.load(stream)
            media_peers = config.pop('media_peers', [])
            config['bindings'] = tuple(VerifiedBinding(**b) for b in config.get('bindings', []))
            config['allowed_peers'] = tuple(tuple(p) for p in config.get('allowed_peers', []))
            config['request_uri_hosts'] = tuple(config.get('request_uri_hosts', []))
            policy = InboundPolicy(**config)
        self.policy = policy
        self.media_peers = frozenset(str(ipaddress.ip_address(p)) for p in (media_peers or []))
        self.request = request or self.local_request

    def local_request(self, route, body):
        connection = http.client.HTTPConnection('127.0.0.1', 8087, timeout=15)
        try:
            connection.request('POST', route, json.dumps(body).encode(), {
                'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            raw = response.read(65537)
            if response.status != 200 or len(raw) > 65536:
                raise RuntimeError('inbound_control_unconfirmed')
            return json.loads(raw)
        finally:
            connection.close()

    def handle(self, message, peer):
        """Called under the bridge call_lock. Return True when fully handled."""
        first = message.split('\r\n', 1)[0]
        headers = {}
        for line in message.split('\r\n\r\n', 1)[0].split('\r\n')[1:]:
            if ':' in line:
                key, value = line.split(':', 1)
                headers[key.lower()] = value.strip()
        if first.startswith('INVITE '):
            self.invite(message, peer, headers)
            return True
        d = self.dialog
        if not d or headers.get('call-id') != d['call_id']:
            return False
        if peer != d['peer']:
            return True
        if first.startswith('SIP/2.0 200') and headers.get('cseq') == d.get('bye_cseq'):
            self.finish(d.get('completion', 'interrumpida'))
            return True
        if not first.startswith(('ACK ', 'BYE ', 'CANCEL ')):
            return True
        if not re.search(r';tag=' + re.escape(d['remote_tag']) + r'(?:;|$)', headers.get('from', '')):
            return True
        if first.startswith('ACK '):
            if d['state'] == 'answered' and headers.get('cseq') == d['sequence'] + ' ACK' and (';tag=' + d['local_tag']) in headers.get('to', ''):
                d['state'] = 'active'
                self.bridge.call_established = True
                self.bridge.start_notified = True
                self.bridge.notify_node_call_start()
            return True
        if first.startswith('CANCEL '):
            if headers.get('cseq') != d['sequence'] + ' CANCEL':
                return True
            self.bridge.reply_sip('200 OK', message, peer)
            if d['state'] == 'preparing':
                self.bridge.reply_sip('487 Request Terminated', d['invite'], peer)
                self.finish('interrumpida')
            # A CANCEL racing with 200 does not undo the established dialog.
            return True
        if first.startswith('BYE ') and (';tag=' + d['local_tag']) in headers.get('to', ''):
            self.bridge.reply_sip('200 OK', message, peer)
            self.finish('finalizada')
        return True

    def invite(self, message, peer, headers):
        b = self.bridge
        try:
            if not b.calls_enabled():
                raise ValueError('calls_disabled')
            resolved = resolve_inbound(message, peer_ip=peer[0], peer_port=peer[1], listener_id=self.policy.listener_id, policy=self.policy, now=int(time.time()))
            if self.dialog:
                if self.dialog['key'] == resolved.dialog_key and peer == self.dialog['peer']:
                    if message != self.dialog['invite']:
                        b.reply_sip('488 Not Acceptable Here', message, peer)
                    elif self.dialog.get('answer'):
                        b.send_sip(self.dialog['answer'], peer)
                    else:
                        b.reply_sip('180 Ringing', message, peer)
                else:
                    b.reply_sip('486 Busy Here', message, peer)
                return
            if b.call_active or self.terminal_pending:
                raise ValueError('busy')
            tag = re.search(r';tag=([A-Za-z0-9_.!%*+`~-]{1,128})(?:;|$)', headers.get('from', ''))
            contact = re.fullmatch(r'<(sip:[A-Za-z0-9_.+!~-]+@[A-Za-z0-9.:-]+)>', headers.get('contact', ''))
            media = re.search(r'(?:^|\r\n)c=IN IP4 ([0-9.]+)\r\n', message)
            audio = re.search(r'(?:^|\r\n)m=audio ([0-9]+) RTP/AVP ([0-9 ]+)\r\n', message)
            if not tag or not contact or not media or media.group(1) not in self.media_peers or not audio or '8' not in audio.group(2).split() or not 1 <= int(audio.group(1)) <= 65535:
                raise ValueError('unsupported_or_untrusted_sdp')
            d = {'key': resolved.dialog_key, 'destination': resolved.destination, 'call_id': headers['call-id'],
                 'sequence': headers['cseq'].split()[0], 'peer': peer, 'invite': message, 'headers': headers,
                 'remote_tag': tag.group(1), 'local_tag': secrets.token_hex(12), 'contact': contact.group(1),
                 'state': 'preparing', 'started': time.monotonic(), 'limit': 120, 'retry_at': 0, 'retries': 0}
            self.dialog = d
            b.call_active = True
            b.call_established = False
            b.call_ending = False
            b.call_started_at = d['started']
            b.call_direction = 'inbound'
            b.session_id = d['key']
            b.call_id = d['call_id']
            b.remote_tag = d['remote_tag']
            b.local_tag = d['local_tag']
            b.caller_phone = ''  # Caller presentation is never an authorization or a confirmed number.
            b.remote_rtp_ip = media.group(1)
            b.remote_rtp_port = int(audio.group(1))
            b.rtp_packets_sent = b.rtp_packets_received = b.rtp_send_errors = b.rtp_receive_errors = 0
            b.reply_sip('180 Ringing', message, peer)
            threading.Thread(target=self.prepare, args=(d,), daemon=True).start()
        except Exception:
            b.reply_sip('403 Forbidden', message, peer)

    def prepare(self, d):
        b = self.bridge
        try:
            response = self.request('/prepare', {'dialogKey': d['key'], 'destino': d['destination']})
            if response.get('sessionId') != d['key'] or type(response.get('maxSeconds')) is not int or not 1 <= response['maxSeconds'] <= 120:
                raise ValueError('invalid_admission')
            with b.call_lock:
                if self.dialog is not d or d['state'] != 'preparing' or not b.calls_enabled():
                    raise ValueError('cancelled_admission')
                d['limit'] = response['maxSeconds']
                h = d['headers']
                lines = ['SIP/2.0 200 OK']
                lines += [line for line in d['invite'].split('\r\n\r\n', 1)[0].split('\r\n')[1:] if line.lower().startswith(('via:', 'record-route:'))]
                lines += ['From: ' + h['from'], 'To: ' + h['to'] + ';tag=' + d['local_tag'], 'Call-ID: ' + d['call_id'], 'CSeq: ' + h['cseq'],
                          f'Contact: <sip:{b.sip_user}@{b.public_ip or b.local_ip}:{b.public_sip_port or b.sip_port}>', 'Content-Type: application/sdp']
                sdp = b.build_sdp()
                lines += ['Content-Length: ' + str(len(sdp.encode())), '', sdp]
                d['answer'] = '\r\n'.join(lines)
                d['state'] = 'answered'
                d['retry_at'] = time.monotonic() + 0.5
                b.send_sip(d['answer'], d['peer'])
                b.prime_rtp_nat()
        except Exception:
            with b.call_lock:
                if self.dialog is d:
                    b.reply_sip('480 Temporarily Unavailable', d['invite'], d['peer'])
                    self.finish('interrumpida')
            # Even a late successful admission must be closed after cancellation.
            self.terminal(d['key'], 'interrumpida')

    def hangup(self):
        d = self.dialog
        if not d or d['state'] == 'ending':
            return
        if d['state'] == 'preparing':
            self.bridge.reply_sip('480 Temporarily Unavailable', d['invite'], d['peer'])
            self.finish('interrumpida')
            return
        b = self.bridge
        d['state'] = 'ending'
        b.call_ending = True
        b.cseq += 1
        d['bye_cseq'] = str(b.cseq) + ' BYE'
        h = d['headers']
        lines = ['BYE ' + d['contact'] + ' SIP/2.0', f'Via: SIP/2.0/UDP {b.local_ip}:{b.sip_port};branch=z9hG4bK-{secrets.token_hex(12)};rport',
                 'Max-Forwards: 70', 'From: ' + h['to'] + ';tag=' + d['local_tag'], 'To: ' + h['from'],
                 'Call-ID: ' + d['call_id'], 'CSeq: ' + d['bye_cseq'], 'Content-Length: 0', '', '']
        d['bye'] = '\r\n'.join(lines)
        d['retry_at'] = time.monotonic() + .5
        d['retries'] = 0
        b.send_sip(d['bye'], d['peer'])

    def tick(self):
        d = self.dialog
        if not d:
            return
        elapsed = time.monotonic() - d['started']
        limit = min(d['limit'], 25 if d['state'] in ('preparing', 'answered') else 120)
        if elapsed >= limit and d['state'] != 'ending':
            self.hangup()
        if d['state'] in ('answered', 'ending') and time.monotonic() >= d['retry_at'] and d['retries'] < 8:
            self.bridge.send_sip(d.get('bye') or d['answer'], d['peer'])
            d['retries'] += 1
            d['retry_at'] = time.monotonic() + min(4, .5 * 2 ** d['retries'])
        # Never release an unconfirmed BYE. Operator reconciliation is required.

    def finish(self, state):
        d = self.dialog
        if not d:
            return
        self.dialog = None
        self.terminal_pending = True
        self.terminal_key = d['key']
        self.bridge.terminal_reason = 'hangup' if state == 'finalizada' else 'interrupted'
        self.bridge.reset_call()
        threading.Thread(target=self.terminal, args=(d['key'], state), daemon=True).start()

    def terminal(self, key, state):
        for _ in range(3):
            try:
                result = self.request('/terminal', {'dialogKey': key, 'estado': state})
                if result.get('confirmed') is True:
                    if self.terminal_key == key:
                        self.terminal_pending = False
                        self.terminal_key = None
                    return
            except Exception:
                pass
            time.sleep(.25)
        # Retain local admission lock when backend closure is uncertain.
