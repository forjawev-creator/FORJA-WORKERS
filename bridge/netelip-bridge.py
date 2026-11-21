"""
Netelip Headless SIP & RTP Bridge for OpenAI Realtime
Conecta directamente con la centralita SIP de Netelip (sip.netelip.com)
sin necesidad de softphones ni cables virtuales de audio.
"""

import sys
import os
import json
import time
import socket
import hashlib
import re
import threading
import queue
import collections
import random
import sqlite3
import hmac
import secrets
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    import ctypes
    ctypes.windll.winmm.timeBeginPeriod(1)
except Exception:
    pass

# Constantes del protocolo Audio Bridge TCP (src/audio-bridge.ts)
PACKET_AUDIO = 0x01
PACKET_FLUSH = 0x02
PACKET_PLAYBACK_DRAINED = 0x03
PACKET_CALL_START = 0x04
PACKET_CALL_END = 0x05
PACKET_TURN_END = 0x06
PACKET_PLAYBACK_STARTED = 0x07

class TurnAudioSegment:
    """Representa el segmento de audio continuo perteneciente a un turno específico de conversación."""
    def __init__(self, turn_id: int):
        self.turn_id = turn_id
        self.buffer = bytearray()
        self.turn_ended = False        # PACKET_TURN_END recibido de Node.js
        self.flushed = False           # PACKET_FLUSH recibido de Node.js
        self.started_notified = False  # PACKET_PLAYBACK_STARTED notificado a Node.js
        self.drained_notified = False  # PACKET_PLAYBACK_DRAINED notificado a Node.js
        self.played_bytes = 0

CONTROL_UDP_PORT = 8085

def encode_packet(packet_type: int, turn_id: int = 0, payload: bytes = b"") -> bytes:
    length = len(payload)
    header = bytes([packet_type, turn_id & 0xFF, (length >> 8) & 0xFF, length & 0xFF])
    return header + payload

# Tablas de conversión estándar CCITT ITU-T G.711 A-law <-> PCM16
_SEG_AEND = [0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF]

def _linear2alaw(pcm_val: int) -> int:
    pcm_val = pcm_val >> 3
    if pcm_val >= 0:
        mask = 0xD5
    else:
        mask = 0x55
        pcm_val = -pcm_val - 1

    seg = 8
    for i, bound in enumerate(_SEG_AEND):
        if pcm_val <= bound:
            seg = i
            break

    if seg >= 8:
        return 0x7F ^ mask
    else:
        aval = seg << 4
        if seg < 2:
            aval |= (pcm_val >> 1) & 0x0F
        else:
            aval |= (pcm_val >> seg) & 0x0F
        return aval ^ mask

def _alaw2linear(a_val: int) -> int:
    a_val ^= 0x55
    t = (a_val & 0x0F) << 4
    seg = (a_val & 0x70) >> 4
    if seg == 0:
        t += 8
    elif seg == 1:
        t += 0x108
    else:
        t += 0x108
        t <<= (seg - 1)
    return -t if (a_val & 0x80) == 0 else t

def build_alaw_to_pcm16():
    table = np.zeros(256, dtype=np.int16)
    for i in range(256):
        table[i] = _alaw2linear(i)
    return table

def build_pcm16_to_alaw():
    table = np.zeros(65536, dtype=np.uint8)
    for sample in range(-32768, 32768):
        table[sample + 32768] = _linear2alaw(sample)
    return table

ALAW_TO_PCM16 = build_alaw_to_pcm16()
PCM16_TO_ALAW = build_pcm16_to_alaw()

# Tono estándar de llamada europeo/español (425 Hz, G.711 A-law, 20ms = 160 muestras a 8kHz)
_t_rb = np.linspace(0, 0.020, 160, endpoint=False)
_sine_425 = (np.sin(2 * np.pi * 425 * _t_rb) * 10000).astype(np.int16)
_idx_425 = np.clip(_sine_425.astype(np.int32) + 32768, 0, 65535).astype(np.uint16)
RINGBACK_TONE_FRAME = PCM16_TO_ALAW[_idx_425].tobytes()

def parse_auth_header(header_str):
    params = {}
    for match in re.finditer(r'(\w+)=(?:"([^"]+)"|([^\s,]+))', header_str):
        k = match.group(1)
        v = match.group(2) if match.group(2) is not None else match.group(3)
        params[k] = v
    return params

def calculate_digest(user, realm, password, method, uri, nonce, qop=None, nc="00000001", cnonce=""):
    ha1 = hashlib.md5(f"{user}:{realm}:{password}".encode("utf-8")).hexdigest()
    ha2 = hashlib.md5(f"{method}:{uri}".encode("utf-8")).hexdigest()
    if qop:
        return hashlib.md5(f"{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}".encode("utf-8")).hexdigest()
    return hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode("utf-8")).hexdigest()

def sip_log_summary(first_line):
    """Only allowlisted methods/status codes; never a URI, reason phrase or headers."""
    status = re.match(r"^SIP/2\.0 ([1-6][0-9]{2})(?: |$)", first_line)
    if status:
        return "response " + status.group(1)
    method = first_line.split(" ", 1)[0]
    if method in {"INVITE", "ACK", "BYE", "CANCEL", "OPTIONS", "REGISTER", "REFER", "NOTIFY", "INFO", "UPDATE", "PRACK"}:
        return "request " + method
    return "unrecognized_message"


class NetelipSipBridge:
    def __init__(self, config_path="data/config.json"):
        self.config_path = config_path
        self.load_config()

        self.sip_domain = "sip.netelip.com"
        self.sip_server_ip = "194.140.135.80"
        self.sip_server_port = 5060

        self.tcp_host = "127.0.0.1"
        self.tcp_port = 8080

        self.sip_sock = None
        self.rtp_sock = None
        self.tcp_sock = None

        self.local_ip = "127.0.0.1"
        self.public_ip = None
        self.public_sip_port = None
        self.sip_port = 5082
        self.rtp_port = 40000

        self.running = False
        self.registered = False
        self.last_register_time = 0
        self.register_expires_at = 0.0
        self.register_transaction = None
        self.register_error = "not_registered"
        self.register_call_id = "reg-" + secrets.token_hex(16)

        # Estado de llamada actual
        self.call_lock = threading.RLock()
        self.call_established = False
        self.start_notified = False
        self.call_ending = False
        self.cancel_sent = False
        self.invite_provisional = False
        self.invite_cseq = 0
        self.last_invite_request = ""
        self.session_id = None
        self.call_started_at = 0.0
        self.terminal_reason = ""
        self.last_control_packet = None
        self.control_retry_at = 0.0
        self.control_retry_count = 0
        self.allowed_numbers = {x.strip().lstrip("+") for x in os.environ.get("CALL_ALLOWED_NUMBERS", "").split(",") if x.strip()}
        self.pilot = os.environ.get("CALLS_PILOT") == "1"
        self.call_active = False
        self.call_id = None
        self.remote_tag = None
        self.local_tag = None
        self.remote_rtp_ip = None
        self.remote_rtp_port = None
        self.caller_phone = None
        self.callee_phone = None
        self.call_direction = "outbound"
        self.cseq = 1

        # RTP counters y control estricto de espaciado anti-ráfaga
        self.rtp_seq = random.randint(100, 10000)
        self.rtp_timestamp = random.randint(1000, 100000)
        self.rtp_ssrc = random.randint(100000, 999999)
        self.rtp_send_lock = threading.Lock()
        self.last_actual_rtp_send_time = 0.0

        # Cola estructurada de audio por turnos (OpenAI -> Netelip)
        self.turn_segments = collections.deque()
        self.active_segment = None
        self.flushed_turn_ids = set()
        self.outbound_audio_lock = threading.Lock()
        self.pending_session_id = None
        self.tcp_send_lock = threading.Lock()

        # Leg 2 (Transferencia B2BUA hacia humano / Miguel)
        self.leg2_active = False
        self.leg2_call_id = None
        self.leg2_cseq = 1
        self.leg2_local_tag = None
        self.leg2_remote_tag = None
        self.leg2_target_phone = None
        self.leg2_remote_rtp_ip = None
        self.leg2_remote_rtp_port = None
        self.leg2_rtp_sock = None
        self.leg2_rtp_port = 40002
        self.is_bridged = False
        self.ringback_active = False

        # API HTTP de Control e idempotencia
        self.control_secret = self.load_control_secret()
        self.seen_call_ids = set()
        self.rtp_packets_sent = 0
        self.rtp_send_errors = 0
        self.rtp_receive_errors = 0
        self.rtp_totals = {"sent": 0, "received": 0, "send_errors": 0, "receive_errors": 0}
        self.rtp_packets_received = 0
        self.rtp_jitter_samples = []
        self.buffer_underruns = 0
        self.buffer_overflows = 0
        self.inbound_service = None
        if os.environ.get("TELEPHONY_MODE") == "inbound_secretaria":
            from inbound_service import InboundService
            self.inbound_service = InboundService(self)

    def calls_enabled(self):
        if os.environ.get("TELEPHONY_MODE") == "inbound_secretaria" and os.environ.get("INBOUND_ENABLED") != "true":
            return False
        try:
            policy = os.path.join(os.path.dirname(os.path.abspath(self.config_path)), "runtime-policy.json")
            with open(policy, encoding="utf-8") as f:
                return json.load(f).get("realCallsEnabled") is True
        except (OSError, ValueError, AttributeError):
            return False

    def require_calls_enabled(self):
        if not self.calls_enabled():
            raise RuntimeError("Telefonía real bloqueada por runtime-policy")

    def registration_valid(self):
        if self.registered and time.monotonic() >= self.register_expires_at:
            self.registered = False
            self.register_error = "expired"
        return self.registered

    def handle_register_response(self, msg):
        cseq = re.search(r"^CSeq:\s*(\d+)\s+REGISTER\s*$", msg, re.I | re.M)
        if not cseq:
            return False
        call_id = re.search(r"^Call-ID:\s*([^\r\n]+)", msg, re.I | re.M)
        branch = re.search(r"^Via:.*?;branch=([^;\s]+)", msg, re.I | re.M)
        pending = self.register_transaction
        if not pending or not call_id or not branch:
            return True
        if (int(cseq.group(1)), call_id.group(1).strip(), branch.group(1)) != pending[:3]:
            return True
        code = re.match(r"SIP/2.0 (\d{3})", msg)
        if not code:
            return True
        status = int(code.group(1))
        if status in (401, 407):
            self.registered = False
            self.register_error = "authentication_required"
            if pending[3]:
                self.register_transaction = None
                self.register_error = "authentication_rejected"
                return True
            match = re.search(r"(?:WWW|Proxy)-Authenticate:\s*Digest\s+([^\r\n]+)", msg, re.I)
            if match:
                params = parse_auth_header(match.group(1))
                realm, nonce = params.get("realm", self.sip_domain), params.get("nonce", "")
                if not nonce:
                    return True
                uri = "sip:" + self.sip_domain
                response = calculate_digest(self.sip_user, realm, self.sip_pass, "REGISTER", uri, nonce)
                header = "Proxy-Authorization" if status == 407 else "Authorization"
                self.send_register(f'{header}: Digest username="{self.sip_user}", realm="{realm}", nonce="{nonce}", uri="{uri}", response="{response}", algorithm=MD5')
            return True
        if status >= 200:
            self.register_transaction = None
            if status == 200:
                contact = re.search(r"^Contact:.*?;expires=(\d+)", msg, re.I | re.M)
                expires = contact or re.search(r"^Expires:\s*(\d+)", msg, re.I | re.M)
                seconds = min(60, int(expires.group(1))) if expires else 60
                self.registered = seconds > 0
                self.register_expires_at = time.monotonic() + seconds
                self.last_register_time = time.time()
                self.register_error = "" if self.registered else "expired"
            else:
                self.registered = False
                self.register_expires_at = 0.0
                self.register_error = "rejected_" + str(status)
        return True

    def reset_rtp_metrics(self):
        self.rtp_packets_sent = self.rtp_packets_received = 0
        self.rtp_send_errors = self.rtp_receive_errors = 0

    def load_control_secret(self):
        secret = os.environ.get("VOICE_CONTROL_SECRET", "").strip()
        if secret:
            return secret
        env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
        if os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line_str = line.strip()
                        if line_str.startswith("VOICE_CONTROL_SECRET="):
                            return line_str.split("=", 1)[1].strip().strip('"').strip("'")
            except:
                pass
        return ""

    def ledger(self):
        directory = os.path.dirname(os.path.abspath(self.config_path))
        os.makedirs(directory, exist_ok=True)
        db = sqlite3.connect(os.path.join(directory, "voice-control.sqlite3"), timeout=5)
        db.execute("PRAGMA synchronous=FULL")
        db.execute("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        legacy = os.path.join(directory, "voice-control-ledger.json")
        if os.path.exists(legacy):
            with open(legacy, encoding="utf-8") as f:
                entries = json.load(f)
            if not isinstance(entries, list) or not all(isinstance(x, str) for x in entries):
                db.close()
                raise ValueError("Registro de llamadas anterior inválido")
            db.executemany("INSERT OR IGNORE INTO calls VALUES (?, '')", [(x,) for x in entries])
            db.commit()
        return db

    def is_call_id_seen(self, call_id):
        with self.ledger() as db:
            return db.execute("SELECT 1 FROM calls WHERE id=?", (call_id,)).fetchone() is not None

    def record_call_id(self, call_id, payload=""):
        if not call_id:
            raise ValueError("call_id requerido")
        with self.ledger() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT payload FROM calls WHERE id=?", (call_id,)).fetchone()
            if previous:
                if previous[0] and payload and previous[0] != payload:
                    raise ValueError("call_id reutilizado con datos distintos")
                return False
            db.execute("INSERT INTO calls VALUES (?, ?)", (call_id, payload))
            return True

    def validate_destination(self, phone):
        if not isinstance(phone, str) or not re.fullmatch(r"\+?[1-9]\d{7,14}", phone):
            raise ValueError("Número internacional inválido")
        normalized = phone.lstrip("+")
        if self.pilot and not self.allowed_numbers:
            raise ValueError("Piloto sin destino permitido")
        if self.allowed_numbers and normalized not in self.allowed_numbers:
            raise ValueError("Destino no permitido para esta prueba")
        return normalized

    def reply_sip(self, status, msg, addr):
        headers = [line for line in msg.split("\r\n") if line.lower().startswith(("via:", "from:", "to:", "call-id:", "cseq:"))]
        self.send_sip("SIP/2.0 " + status + "\r\n" + "\r\n".join(headers) + "\r\nContent-Length: 0\r\n\r\n", addr)

    def transaction_request(self, method, response=""):
        # CANCEL and non-2xx ACK reuse the INVITE branch, CSeq and request URI.
        lines = self.last_invite_request.split("\r\n")
        target = f"sip:{self.callee_phone}@{self.sip_domain}"
        if lines and lines[0].startswith("INVITE "):
            target = lines[0].split(" ")[1]
        keep = [x for x in lines[1:] if x.lower().startswith(("via:", "from:", "to:", "call-id:", "route:", "max-forwards:"))]
        if not keep:
            keep = [f"Via: SIP/2.0/UDP {self.local_ip}:{self.sip_port};branch=z9hG4bK-inv-{self.invite_cseq or self.cseq};rport",
                    f"From: <sip:{self.sip_user}@{self.sip_domain}>;tag={self.local_tag}",
                    f"To: <{target}>", f"Call-ID: {self.call_id}"]
        if response and method == "ACK":
            to = next((x for x in response.split("\r\n") if x.lower().startswith("to:")), None)
            if to: keep = [to if x.lower().startswith("to:") else x for x in keep]
        keep += [f"CSeq: {self.invite_cseq or self.cseq} {method}", "Content-Length: 0", "", ""]
        return f"{method} {target} SIP/2.0\r\n" + "\r\n".join(keep)

    def send_cancel(self):
        if self.cancel_sent:
            return
        self.cancel_sent = True
        self.send_control(self.transaction_request("CANCEL"))

    def send_control(self, packet):
        self.last_control_packet = packet
        self.control_retry_count = 0
        self.control_retry_at = time.monotonic() + 0.5
        self.send_sip(packet)

    def call_safety_loop(self):
        while self.running:
            with self.call_lock:
                if self.inbound_service:
                    self.inbound_service.tick()
                elif self.call_active and self.call_started_at:
                    limit = 120 if self.call_established else 35
                    if not self.call_ending and time.monotonic() - self.call_started_at > limit:
                        self.terminal_reason = "duration_limit" if self.call_established else "no_answer"
                        self.hangup()
                    if self.last_control_packet and self.control_retry_count < 6 and time.monotonic() >= self.control_retry_at:
                        self.send_sip(self.last_control_packet)
                        self.control_retry_count += 1
                        self.control_retry_at = time.monotonic() + min(4, 0.5 * 2 ** self.control_retry_count)
            time.sleep(0.25)

    def load_config(self):
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            self.sip_user = cfg.get("sipUser", "2859181451")
            self.sip_pass = cfg.get("sipPassword", "")
            self.caller_id = cfg.get("sipCallerId", "")
            self.transfer_phone = cfg.get("humanTransferPhone", "")
            print("[NetelipBridge] Configuración cargada")
        except Exception as e:
            print(f"[NetelipBridge] Error leyendo configuración: {type(e).__name__}")
            self.sip_user = "2859181451"
            self.sip_pass = ""
            self.caller_id = ""
            self.transfer_phone = ""

    def determine_local_ip(self):
        old_ip = getattr(self, "local_ip", None)
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((self.sip_server_ip, self.sip_server_port))
            self.local_ip = s.getsockname()[0]
            s.close()
        except:
            self.local_ip = "127.0.0.1"
        if old_ip != self.local_ip:
            print("[NetelipBridge] Dirección local detectada")

    def start(self):
        self.require_calls_enabled()
        if not self.control_secret:
            raise RuntimeError("VOICE_CONTROL_SECRET requerido")
        if self.pilot and not self.allowed_numbers:
            raise RuntimeError("Piloto sin número autorizado")
        self.running = True
        self.determine_local_ip()

        # Socket SIP UDP
        self.sip_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Intentar enlazar en puerto 5082 o incremental
        for p in range(5082, 5100):
            try:
                self.sip_sock.bind(("0.0.0.0", p))
                self.sip_port = p
                break
            except:
                continue

        print(f"[NetelipBridge] Socket SIP UDP escuchando en puerto {self.sip_port}")

        # Socket RTP UDP
        self.rtp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for p in range(40000, 40100, 2):
            try:
                self.rtp_sock.bind(("0.0.0.0", p))
                self.rtp_port = p
                break
            except:
                continue

        print(f"[NetelipBridge] Socket RTP UDP escuchando en puerto {self.rtp_port}")

        # Iniciar hilos de trabajo
        threading.Thread(target=self.sip_receiver_loop, daemon=True).start()
        threading.Thread(target=self.registration_maintainer, daemon=True).start()
        threading.Thread(target=self.rtp_receiver_loop, daemon=True).start()
        threading.Thread(target=self.rtp_sender_loop, daemon=True).start()
        threading.Thread(target=self.call_safety_loop, daemon=True).start()
        threading.Thread(target=self.http_control_listener, daemon=True).start()

        # Conectar al Audio Bridge TCP (Node.js) e iniciar hilo único de recepción
        self.connect_tcp_bridge()
        threading.Thread(target=self.tcp_receiver_loop, daemon=True).start()

        print("[NetelipBridge] ✅ Centralita Headless Netelip activa y lista.")

    def connect_tcp_bridge(self):
        try:
            if self.tcp_sock:
                try:
                    self.tcp_sock.close()
                except:
                    pass
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.connect((self.tcp_host, self.tcp_port))
            self.tcp_sock = sock
            if self.inbound_service:
                self.send_tcp(encode_packet(8, 0, self.inbound_service.token.encode()))
            print("[NetelipBridge] Conectado al puente local de audio")
        except Exception as e:
            self.tcp_sock = None
            print(f"[NetelipBridge] Fallo de conexión al puente local: {type(e).__name__}; pendiente de reintento")

    def send_sip(self, msg_str, target_addr=None):
        if self.sip_sock:
            try:
                dest = target_addr or (self.sip_server_ip, self.sip_server_port)
                self.sip_sock.sendto(msg_str.encode("utf-8"), dest)
            except Exception as e:
                print(f"[NetelipBridge] Error en send_sip: {type(e).__name__}")

    def send_register(self, auth_header=""):
        self.require_calls_enabled()
        self.cseq += 1
        self.register_transaction = (self.cseq, self.register_call_id, f"z9hG4bK-reg-{self.cseq}", bool(auth_header))
        contact_ip = self.public_ip or self.local_ip
        contact_port = self.public_sip_port or self.sip_port
        reg = (
            f"REGISTER sip:{self.sip_domain} SIP/2.0\r\n"
            f"Via: SIP/2.0/UDP {self.local_ip}:{self.sip_port};branch=z9hG4bK-reg-{self.cseq};rport\r\n"
            f"Max-Forwards: 70\r\n"
            f"From: <sip:{self.sip_user}@{self.sip_domain}>;tag=netelip-reg\r\n"
            f"To: <sip:{self.sip_user}@{self.sip_domain}>\r\n"
            f"Call-ID: {self.register_call_id}\r\n"
            f"CSeq: {self.cseq} REGISTER\r\n"
            f"Contact: <sip:{self.sip_user}@{contact_ip}:{contact_port}>\r\n"
            f"Expires: 60\r\n"
        )
        if auth_header:
            reg += auth_header + "\r\n"
        reg += "Content-Length: 0\r\n\r\n"
        self.send_sip(reg)

    def registration_maintainer(self):
        while self.running:
            try:
                self.registration_valid()
                # Si hay una llamada en curso, NO enviar re-registro ni consultar IP
                # para evitar interferir con las transacciones SIP y el flujo RTP
                if self.call_active:
                    time.sleep(2)
                    continue

                now = time.time()
                # Re-registrar cada 20 segundos para mantener activo el mapeo NAT en el router
                if not self.registration_valid() or (now - self.last_register_time > 20):
                    self.determine_local_ip()
                    self.send_register()
                else:
                    # Keepalive NAT de bajo impacto según RFC 5626 (CRLF doble)
                    if self.sip_sock:
                        try:
                            self.sip_sock.sendto(b"\r\n\r\n", (self.sip_server_ip, self.sip_server_port))
                        except Exception:
                            pass
            except Exception as e:
                print(f"[NetelipBridge] Error en registration_maintainer: {type(e).__name__}")
            time.sleep(10)

    def sip_receiver_loop(self):
        while self.running:
            try:
                data, addr = self.sip_sock.recvfrom(4096)
                msg_str = data.decode("utf-8", errors="ignore")
                self.handle_sip_message(msg_str, addr)
            except Exception as e:
                if self.running:
                    print(f"[NetelipBridge] Error en sip_receiver_loop: {type(e).__name__}")

    def handle_sip_message(self, msg, addr):
        if addr[0] != self.sip_server_ip:
            return
        with self.call_lock:
            self._handle_sip_message(msg, addr)

    def _handle_sip_message(self, msg, addr):
        if self.inbound_service and self.inbound_service.handle(msg, addr):
            return
        lines = msg.split("\r\n")
        if not lines:
            return
        first_line = lines[0].strip()

        # Log de diagnóstico para mensajes SIP entrantes (excepto keepalives rutinarios de registro)
        if "REGISTER" not in msg and not first_line.startswith("ACK sip:"):
            print(f"[NetelipBridge] SIP << {sip_log_summary(first_line)}")

        # Aprender mapeo NAT (IP pública y rport) de las respuestas de Netelip
        match_received = re.search(r"received=([0-9\.]+)", msg)
        match_rport = re.search(r"rport=(\d+)", msg)
        first_time_nat = False
        if match_received and match_received.group(1) != self.public_ip:
            self.public_ip = match_received.group(1)
            first_time_nat = True
        if match_rport and int(match_rport.group(1)) != self.public_sip_port:
            self.public_sip_port = int(match_rport.group(1))
            first_time_nat = True

        call_id_match = re.search(r"Call-ID:\s*(.+)", msg, re.I)
        msg_call_id = call_id_match.group(1).strip() if call_id_match else ""

        # ==============================================================
        # PROCESAMIENTO DE MENSAJES PARA LEG 2 (TRANSFERENCIA B2BUA)
        # ==============================================================
        if self.leg2_active and self.leg2_call_id and msg_call_id == self.leg2_call_id:
            # 1. Desafío 401 / 407 en Leg 2
            if first_line.startswith("SIP/2.0 401") or first_line.startswith("SIP/2.0 407"):
                auth_header_name = "Proxy-Authenticate" if "Proxy-Authenticate" in msg else "WWW-Authenticate"
                match = re.search(rf"{auth_header_name}:\s*Digest\s+(.*)", msg, re.I)
                if match:
                    params = parse_auth_header(match.group(1))
                    realm = params.get("realm", self.sip_domain)
                    nonce = params.get("nonce", "")
                    uri = f"sip:{self.leg2_target_phone}@{self.sip_domain}"
                    response = calculate_digest(self.sip_user, realm, self.sip_pass, "INVITE", uri, nonce)
                    req_auth_header = "Proxy-Authorization" if "Proxy-Authenticate" in msg else "Authorization"
                    auth_str = (
                        f'{req_auth_header}: Digest username="{self.sip_user}", realm="{realm}", '
                        f'nonce="{nonce}", uri="{uri}", response="{response}", algorithm=MD5'
                    )
                    self.send_leg2_invite_authenticated(auth_str)
                return

            # 2. Ringing / Progress para Leg 2 (Miguel está recibiendo la llamada)
            if "SIP/2.0 180 Ringing" in first_line or "SIP/2.0 183 Session Progress" in first_line:
                print("[NetelipBridge] Leg 2: sonando")
                if not self.ringback_active and not self.is_bridged:
                    self.ringback_active = True
                    threading.Thread(target=self.ringback_sender_loop, daemon=True).start()
                return

            # 3. 200 OK para Leg 2 (Miguel ha descolgado)
            if "SIP/2.0 200 OK" in first_line and "INVITE" in msg:
                print("[NetelipBridge] Transferencia conectada; enlazando audio B2BUA")
                self.ringback_active = False
                match_ip = re.search(r"c=IN IP4 ([0-9\.]+)", msg)
                match_port = re.search(r"m=audio (\d+) RTP", msg)
                if match_ip and match_port:
                    self.leg2_remote_rtp_ip = match_ip.group(1)
                    self.leg2_remote_rtp_port = int(match_port.group(1))
                    print("[NetelipBridge] Destino RTP de Leg 2 establecido")

                match_to = re.search(r"To:.*tag=([a-zA-Z0-9_\-]+)", msg, re.I)
                if match_to:
                    self.leg2_remote_tag = match_to.group(1)

                self.send_leg2_ack()
                self.is_bridged = True
                return

            # 4. Errores o rechazo en Leg 2 (486 Busy, 487 Cancelled, 408 Timeout, etc.)
            if first_line.startswith("SIP/2.0 4") or first_line.startswith("SIP/2.0 5") or first_line.startswith("SIP/2.0 6"):
                print(f"[NetelipBridge] Leg 2 no disponible: {sip_log_summary(first_line)}; finalizando enlace")
                self.ringback_active = False
                self.reset_leg2()
                return

            # 5. BYE de Leg 2 (Miguel cuelga)
            if first_line.startswith("BYE sip:"):
                print("[NetelipBridge] Leg 2: colgado recibido")
                self.send_sip("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n", addr)
                self.reset_leg2()
                self.hangup()
                return

        if self.handle_register_response(msg):
            return

        cseq_match = re.search(r"CSeq:\s*(\d+)\s+([A-Z]+)", msg, re.I)
        method = cseq_match.group(2).upper() if cseq_match else ""
        is_request = not first_line.startswith("SIP/2.0")
        if first_line.startswith("INVITE sip:"):
            if not self.calls_enabled() or self.pilot or not self.inbound_service or (self.call_active and msg_call_id != self.call_id):
                self.reply_sip("486 Busy Here", msg, addr)
                return
        elif not self.call_active or not msg_call_id or msg_call_id != self.call_id:
            if is_request and not first_line.startswith("ACK "):
                self.reply_sip("481 Call/Transaction Does Not Exist", msg, addr)
            return
        if not is_request and method == "INVITE" and self.invite_cseq and int(cseq_match.group(1)) != self.invite_cseq:
            return
        if is_request and method in ("BYE", "CANCEL"):
            from_tag = re.search(r"From:.*?;tag=([^;\s]+)", msg, re.I)
            to_tag = re.search(r"To:.*?;tag=([^;\s]+)", msg, re.I)
            if ((self.remote_tag and (not from_tag or from_tag.group(1) != self.remote_tag))
                    or (self.local_tag and to_tag and to_tag.group(1) != self.local_tag)):
                self.reply_sip("481 Call/Transaction Does Not Exist", msg, addr)
                return
        if method == "BYE" and first_line.startswith("SIP/2.0 200") and self.call_ending and int(cseq_match.group(1)) == self.cseq:
            self.reset_call()
            return
        if method == "INVITE" and re.match(r"SIP/2.0 [3-6]\d\d", first_line) and not re.match(r"SIP/2.0 (401|407)\b", first_line):
            self.send_sip(self.transaction_request("ACK", msg))
            self.terminal_reason = first_line.split(" ", 2)[1]
            self.reset_call()
            return

        # 2. Respuestas a INVITE o REFER saliente (401 / 407 Digest Challenge)
        if first_line.startswith("SIP/2.0 401") or first_line.startswith("SIP/2.0 407"):
            cseq_match = re.search(r"CSeq:\s*\d+\s+([A-Z]+)", msg, re.I)
            cseq_method = cseq_match.group(1).upper() if cseq_match else ""

            if cseq_method == "REFER":
                print(f"[NetelipBridge] 🔐 Desafío 401/407 recibido de Netelip para REFER.")
                return
            elif (cseq_method == "INVITE" or not cseq_method) and self.call_active and self.call_direction == "outbound":
                auth_header_name = "Proxy-Authenticate" if "Proxy-Authenticate" in msg else "WWW-Authenticate"
                match = re.search(rf"{auth_header_name}:\s*Digest\s+(.*)", msg, re.I)
                if match:
                    self.send_sip(self.transaction_request("ACK", msg))
                    if self.call_ending:
                        self.reset_call()
                        return
                    params = parse_auth_header(match.group(1))
                    realm = params.get("realm", self.sip_domain)
                    nonce = params.get("nonce", "")
                    uri = f"sip:{self.callee_phone}@{self.sip_domain}"
                    response = calculate_digest(self.sip_user, realm, self.sip_pass, "INVITE", uri, nonce)
                    req_auth_header = "Proxy-Authorization" if "Proxy-Authenticate" in msg else "Authorization"
                    auth_str = (
                        f'{req_auth_header}: Digest username="{self.sip_user}", realm="{realm}", '
                        f'nonce="{nonce}", uri="{uri}", response="{response}", algorithm=MD5'
                    )
                    self.send_invite_authenticated(auth_str)
                return
            return

        if "SIP/2.0 180 Ringing" in first_line or "SIP/2.0 183 Session Progress" in first_line:
            print(f"[NetelipBridge] 📞 Llamada saliente: Sonando / Progreso de sesión...")
            self.invite_provisional = True
            if self.call_ending:
                self.send_cancel()
            # Extraer SDP si viene en 183
            self.extract_remote_sdp(msg)
            return

        if "SIP/2.0 200 OK" in first_line and "INVITE" in msg:
            print(f"[NetelipBridge] 🟢 LLAMADA SALIENTE CONECTADA: El interlocutor ha descolgado.")
            self.extract_remote_sdp(msg)
            # Extraer remote tag
            match_to = re.search(r"To:.*tag=([a-zA-Z0-9_\-]+)", msg, re.I)
            if match_to:
                self.remote_tag = match_to.group(1)

            # Enviar ACK
            self.send_ack()
            was_established = self.call_established
            self.call_established = True
            if self.call_ending:
                if not was_established:
                    self.send_bye()
            elif not self.start_notified:
                self.last_control_packet = None
                self.start_notified = True
                self.notify_node_call_start()
            return

        # Respuestas de transferencia REFER
        if "SIP/2.0 202 Accepted" in first_line:
            print(f"[NetelipBridge] 🔀 202 Accepted: Netelip ha aceptado la petición REFER de transferencia.")
            return

        # Notificación NOTIFY de Netelip durante la transferencia
        if first_line.startswith("NOTIFY sip:"):
            print(f"[NetelipBridge] 📨 NOTIFY recibido de Netelip (estado de la transferencia).")
            self.handle_remote_notify(msg, addr)
            return

        # ACK recibido de Netelip (en respuesta a nuestro 200 OK de llamada entrante)
        if first_line.startswith("ACK sip:"):
            print(f"[NetelipBridge] ✅ ACK recibido de Netelip: Conversación en curso.")
            return

        # 3. Llamada entrante (INVITE desde Netelip)
        if first_line.startswith("INVITE sip:"):
            print(f"\n[NetelipBridge] 📲 LLAMADA ENTRANTE RECIBIDA DE NETELIP!")
            self.handle_inbound_invite(msg, addr)
            return

        # 4. Colgado (BYE)
        if first_line.startswith("BYE sip:"):
            print(f"[NetelipBridge] 📴 LLAMADA FINALIZADA POR EL CLIENTE (BYE recibido)")
            self.handle_remote_bye(msg, addr)
            return

        # 5. Cancelación (CANCEL)
        if first_line.startswith("CANCEL sip:"):
            print(f"[NetelipBridge] 📴 LLAMADA CANCELADA (CANCEL recibido)")
            self.handle_remote_cancel(msg, addr)
            return

    def extract_remote_sdp(self, msg):
        match_ip = re.search(r"c=IN IP4 ([0-9\.]+)", msg)
        match_port = re.search(r"m=audio (\d+) RTP", msg)
        if match_ip and match_port:
            self.remote_rtp_ip = match_ip.group(1)
            self.remote_rtp_port = int(match_port.group(1))
            print("[NetelipBridge] Destino RTP establecido")

    def build_sdp(self):
        contact_ip = self.public_ip or self.local_ip
        return (
            "v=0\r\n"
            f"o={self.sip_user} 123456 123456 IN IP4 {contact_ip}\r\n"
            "s=ForjaWeb-VoiceAgent\r\n"
            f"c=IN IP4 {contact_ip}\r\n"
            "t=0 0\r\n"
            f"m=audio {self.rtp_port} RTP/AVP 8 101\r\n"
            "a=rtpmap:8 PCMA/8000\r\n"
            "a=rtpmap:101 telephone-event/8000\r\n"
            "a=fmtp:101 0-16\r\n"
            "a=sendrecv\r\n"
        )

    def handle_inbound_invite(self, msg, addr):
        with self.call_lock:
            lines = msg.split("\r\n")

            # Preservar exactamente todas las cabeceras Via de la transacción original
            vias = [l for l in lines if l.lower().startswith("via:")]
            # Preservar Record-Route en el mismo orden si existen
            record_routes = [l for l in lines if l.lower().startswith("record-route:")]

            from_line = next((l for l in lines if l.lower().startswith("from:")), "")
            to_line = next((l for l in lines if l.lower().startswith("to:")), "")
            call_id_line = next((l for l in lines if l.lower().startswith("call-id:")), "")
            cseq_line = next((l for l in lines if l.lower().startswith("cseq:")), "")

            call_id = call_id_line[8:].strip() if call_id_line else f"inbound-{int(time.time())}"
            cseq = cseq_line[5:].strip() if cseq_line else "1 INVITE"

            # Parsear identificador y teléfono del llamante
            caller_phone = "Desconocido"
            m_phone = re.search(r'(?:From|P-Asserted-Identity|Remote-Party-ID):.*?(?:sip:|\+)?([6789]\d{8}|\d{9,12})@', msg, re.I)
            if m_phone:
                caller_phone = m_phone.group(1)
            else:
                m_from = re.search(r'From:\s*"?([^"<@]+)"?\s*<sip:([^@]+)@', msg, re.I)
                if m_from:
                    caller_phone = m_from.group(2)

            # Si ya tenemos esta llamada activa (retransmisión de INVITE de Netelip sobre UDP):
            if self.call_active and self.call_id == call_id:
                print("[NetelipBridge] Retransmisión INVITE; reenviando 200 OK")
                if hasattr(self, 'last_200_ok') and self.last_200_ok:
                    self.send_sip(self.last_200_ok, addr)
                return

            from_tag_match = re.search(r"From:.*tag=([a-zA-Z0-9_\-]+)", msg, re.I)
            self.remote_tag = from_tag_match.group(1).strip() if from_tag_match else ""
            self.local_tag = f"tag-{random.randint(100000, 999999)}"

            self.call_id = call_id
            self.caller_phone = caller_phone
            self.call_active = True
            self.call_direction = "inbound"
            self.remote_addr = addr
            self.record_routes = record_routes
            m_contact = re.search(r'Contact:\s*<([^>]+)>', msg, re.I)
            if m_contact:
                self.remote_contact_uri = m_contact.group(1).strip()
            else:
                self.remote_contact_uri = None
            self.extract_remote_sdp(msg)

            print("[NetelipBridge] Llamada entrante identificada")

            # Construir To para la respuesta: si ya tiene tag se deja, si no se le añade nuestro local_tag
            resp_to = to_line
            if ";tag=" not in resp_to.lower():
                resp_to = f"{to_line};tag={self.local_tag}"

            contact_ip = self.public_ip or self.local_ip
            contact_port = self.public_sip_port or self.sip_port

            # 1. Enviar 180 Ringing con las cabeceras exactas de la transacción
            ringing_headers = ["SIP/2.0 180 Ringing"]
            ringing_headers.extend(vias)
            ringing_headers.extend(record_routes)
            ringing_headers.append(from_line)
            ringing_headers.append(resp_to)
            ringing_headers.append(call_id_line)
            ringing_headers.append(cseq_line)
            ringing_headers.append(f"Contact: <sip:{self.sip_user}@{contact_ip}:{contact_port}>")
            ringing_headers.append("Content-Length: 0\r\n\r\n")
            self.send_sip("\r\n".join(ringing_headers), addr)

            # 2. Enviar 200 OK con SDP (Descolgar inmediatamente)
            sdp = self.build_sdp()
            ok_headers = ["SIP/2.0 200 OK"]
            ok_headers.extend(vias)
            ok_headers.extend(record_routes)
            ok_headers.append(from_line)
            ok_headers.append(resp_to)
            ok_headers.append(call_id_line)
            ok_headers.append(cseq_line)
            ok_headers.append(f"Contact: <sip:{self.sip_user}@{contact_ip}:{contact_port}>")
            ok_headers.append("Allow: INVITE, ACK, CANCEL, OPTIONS, BYE, REFER, NOTIFY")
            ok_headers.append("Supported: replaces")
            ok_headers.append("Content-Type: application/sdp")
            ok_headers.append(f"Content-Length: {len(sdp)}")
            ok_headers.append("")
            ok_headers.append(sdp)
            self.last_200_ok = "\r\n".join(ok_headers)
            self.send_sip(self.last_200_ok, addr)
            print("[NetelipBridge] ✅ 200 OK enviado a Netelip con cabeceras exactas RFC 3261. Descolgado.")

            # Iniciar de inmediato envío de paquetes RTP de confort/silencio para perforar NAT hacia Netelip
            self.prime_rtp_nat()

            self.notify_node_call_start()

    def send_rtp_frame(self, payload: bytes) -> bool:
        """Envía una trama RTP garantizando estricta separación temporal anti-ráfaga respecto al último envío físico real."""
        with self.rtp_send_lock:
            if not self.call_active or not self.rtp_sock or not self.remote_rtp_ip or not self.remote_rtp_port:
                return False

            now = time.perf_counter()
            if self.last_actual_rtp_send_time > 0.0:
                elapsed = now - self.last_actual_rtp_send_time
                if elapsed < 0.010:
                    time.sleep(0.010 - elapsed)

            self.rtp_seq = (self.rtp_seq + 1) & 0xFFFF
            self.rtp_timestamp = (self.rtp_timestamp + len(payload)) & 0xFFFFFFFF

            rtp_hdr = bytearray(12)
            rtp_hdr[0] = 0x80
            rtp_hdr[1] = 0x08  # PCMA
            rtp_hdr[2] = (self.rtp_seq >> 8) & 0xFF
            rtp_hdr[3] = self.rtp_seq & 0xFF
            rtp_hdr[4] = (self.rtp_timestamp >> 24) & 0xFF
            rtp_hdr[5] = (self.rtp_timestamp >> 16) & 0xFF
            rtp_hdr[6] = (self.rtp_timestamp >> 8) & 0xFF
            rtp_hdr[7] = self.rtp_timestamp & 0xFF
            rtp_hdr[8] = (self.rtp_ssrc >> 24) & 0xFF
            rtp_hdr[9] = (self.rtp_ssrc >> 16) & 0xFF
            rtp_hdr[10] = (self.rtp_ssrc >> 8) & 0xFF
            rtp_hdr[11] = self.rtp_ssrc & 0xFF

            try:
                self.rtp_sock.sendto(bytes(rtp_hdr) + payload, (self.remote_rtp_ip, self.remote_rtp_port))
                self.rtp_packets_sent += 1
                self.rtp_totals["sent"] += 1
                self.last_actual_rtp_send_time = time.perf_counter()
                return True
            except Exception as e:
                self.rtp_send_errors += 1
                self.rtp_totals["send_errors"] += 1
                self.last_actual_rtp_send_time = time.perf_counter()
                return False

    def prime_rtp_nat(self):
        """Envía ráfaga inicial de silencio RTP (G.711 A-law 0xd5) para abrir el mapeo simétrico en el router NAT con espaciado estricto"""
        silence_payload = bytes([0xD5] * 160)
        for _ in range(5):
            self.send_rtp_frame(silence_payload)

    def dial(self, phone, company="Cliente", session_id=None):
        if self.inbound_service:
            raise RuntimeError("outbound_disabled_in_secretary_mode")
        self.require_calls_enabled()
        phone = self.validate_destination(phone)
        with self.call_lock:
            if self.call_active:
                raise RuntimeError("Línea ocupada")
            self.call_established = False
            self.start_notified = False
            self.call_ending = False
            self.cancel_sent = False
            self.invite_provisional = False
            self.last_control_packet = None
            self.session_id = session_id
            self.reset_rtp_metrics()
            self.call_started_at = time.monotonic()
            self.terminal_reason = ""
            self.load_config()
            with self.outbound_audio_lock:
                self.turn_segments.clear()
                self.active_segment = None
                self.flushed_turn_ids.clear()
                self.last_actual_rtp_send_time = 0.0
            self.pending_session_id = session_id
            # Netelip SIP uses 00 + country code for international dialing.
            # Validate the canonical destination first; format only at this boundary.
            self.callee_phone = "00" + phone
            self.call_direction = "outbound"
            self.call_active = True
            self.call_id = f"outbound-{int(time.time())}-{random.randint(100, 999)}"
            self.local_tag = f"tag-{random.randint(100000, 999999)}"
            self.remote_tag = None
            self.cseq += 1

            contact_ip = self.public_ip or self.local_ip
            contact_port = self.public_sip_port or self.sip_port
            sdp = self.build_sdp()
            invite = (
                f"INVITE sip:{self.callee_phone}@{self.sip_domain} SIP/2.0\r\n"
                f"Via: SIP/2.0/UDP {self.local_ip}:{self.sip_port};branch=z9hG4bK-inv-{self.cseq};rport\r\n"
                f"Max-Forwards: 70\r\n"
                f"From: <sip:{self.sip_user}@{self.sip_domain}>;tag={self.local_tag}\r\n"
                f"To: <sip:{self.callee_phone}@{self.sip_domain}>\r\n"
                f"Call-ID: {self.call_id}\r\n"
                f"CSeq: {self.cseq} INVITE\r\n"
                f"Contact: <sip:{self.sip_user}@{contact_ip}:{contact_port}>\r\n"
                f"Content-Type: application/sdp\r\n"
                f"Content-Length: {len(sdp)}\r\n\r\n"
                + sdp
            )
            print("[NetelipBridge] Marcado solicitado al operador")
            self.last_invite_request = invite
            self.invite_cseq = self.cseq
            self.send_sip(invite)

    def send_invite_authenticated(self, auth_header):
        self.cseq += 1
        contact_ip = self.public_ip or self.local_ip
        contact_port = self.public_sip_port or self.sip_port
        sdp = self.build_sdp()
        invite = (
            f"INVITE sip:{self.callee_phone}@{self.sip_domain} SIP/2.0\r\n"
            f"Via: SIP/2.0/UDP {self.local_ip}:{self.sip_port};branch=z9hG4bK-inv-{self.cseq};rport\r\n"
            f"Max-Forwards: 70\r\n"
            f"From: <sip:{self.sip_user}@{self.sip_domain}>;tag={self.local_tag}\r\n"
            f"To: <sip:{self.callee_phone}@{self.sip_domain}>\r\n"
            f"Call-ID: {self.call_id}\r\n"
            f"CSeq: {self.cseq} INVITE\r\n"
            f"Contact: <sip:{self.sip_user}@{contact_ip}:{contact_port}>\r\n"
            f"{auth_header}\r\n"
            f"Content-Type: application/sdp\r\n"
            f"Content-Length: {len(sdp)}\r\n\r\n"
            + sdp
        )
        self.last_invite_request = invite
        self.invite_cseq = self.cseq
        self.send_sip(invite)

    def send_ack(self):
        target = self.callee_phone if self.call_direction == "outbound" else self.caller_phone
        to_str = f"<sip:{target}@{self.sip_domain}>"
        if self.remote_tag:
            to_str += f";tag={self.remote_tag}"

        ack = (
            f"ACK sip:{target}@{self.sip_domain} SIP/2.0\r\n"
            f"Via: SIP/2.0/UDP {self.local_ip}:{self.sip_port};branch=z9hG4bK-ack-{self.cseq};rport\r\n"
            f"Max-Forwards: 70\r\n"
            f"From: <sip:{self.sip_user}@{self.sip_domain}>;tag={self.local_tag}\r\n"
            f"To: {to_str}\r\n"
            f"Call-ID: {self.call_id}\r\n"
            f"CSeq: {self.cseq} ACK\r\n"
            f"Content-Length: 0\r\n\r\n"
        )
        self.send_sip(ack)

    def ringback_sender_loop(self):
        """Genera tono de llamada europeo (425Hz, 1s encendido, 3s silencio) hacia Leg 1 mientras suena el teléfono de Miguel (Leg 2)"""
        cadence_counter = 0
        while self.running and self.call_active and self.ringback_active and not self.is_bridged:
            if not self.rtp_sock or not self.remote_rtp_ip or not self.remote_rtp_port:
                time.sleep(0.02)
                continue

            # 1 segundo ON (50 tramas de 20ms), 3 segundos OFF (150 tramas)
            payload = RINGBACK_TONE_FRAME if (cadence_counter % 200 < 50) else b"\xd5" * 160
            cadence_counter += 1

            self.rtp_seq = (self.rtp_seq + 1) & 0xFFFF
            self.rtp_timestamp = (self.rtp_timestamp + 160) & 0xFFFFFFFF
            rtp_hdr = bytearray(12)
            rtp_hdr[0] = 0x80
            rtp_hdr[1] = 0x08
            rtp_hdr[2] = (self.rtp_seq >> 8) & 0xFF
            rtp_hdr[3] = self.rtp_seq & 0xFF
            rtp_hdr[4] = (self.rtp_timestamp >> 24) & 0xFF
            rtp_hdr[5] = (self.rtp_timestamp >> 16) & 0xFF
            rtp_hdr[6] = (self.rtp_timestamp >> 8) & 0xFF
            rtp_hdr[7] = self.rtp_timestamp & 0xFF
            rtp_hdr[8] = (self.rtp_ssrc >> 24) & 0xFF
            rtp_hdr[9] = (self.rtp_ssrc >> 16) & 0xFF
            rtp_hdr[10] = (self.rtp_ssrc >> 8) & 0xFF
            rtp_hdr[11] = self.rtp_ssrc & 0xFF

            try:
                self.rtp_sock.sendto(bytes(rtp_hdr) + payload, (self.remote_rtp_ip, self.remote_rtp_port))
                self.rtp_packets_sent += 1
                self.rtp_totals["sent"] += 1
            except Exception:
                pass
            time.sleep(0.020)

    def leg2_rtp_receiver_loop(self):
        """Recibe audio G.711 A-law desde Miguel (Leg 2) y lo reenvía directamente al Interlocutor (Leg 1)"""
        while self.running and self.leg2_active:
            try:
                if not self.leg2_rtp_sock:
                    time.sleep(0.02)
                    continue
                data, addr = self.leg2_rtp_sock.recvfrom(2048)
                if not self.leg2_active or len(data) <= 12:
                    continue

                if self.is_bridged and self.rtp_sock and self.remote_rtp_ip and self.remote_rtp_port:
                    try:
                        self.rtp_sock.sendto(data, (self.remote_rtp_ip, self.remote_rtp_port))
                    except Exception:
                        pass
            except Exception:
                if self.running and self.leg2_active:
                    pass

    def transfer_call(self, target_phone=None):
        if self.inbound_service:
            raise RuntimeError("transfer_disabled_in_secretary_mode")
        self.require_calls_enabled()
        if self.pilot:
            raise RuntimeError("Transferencias deshabilitadas en el piloto")
        target = target_phone or self.transfer_phone or ""
        clean_target = target.replace("+", "").replace(" ", "")
        print("[NetelipBridge] Iniciando transferencia B2BUA")

        if not self.call_active:
            print("[NetelipBridge] No hay llamada activa para transferir.")
            return

        with self.call_lock:
            self.leg2_active = True
            self.is_bridged = False
            self.ringback_active = False
            self.leg2_target_phone = clean_target
            self.leg2_call_id = f"transfer-leg2-{int(time.time())}-{random.randint(100, 999)}"
            self.leg2_local_tag = f"tag-{random.randint(100000, 999999)}"
            self.leg2_remote_tag = None
            self.leg2_cseq = 1

            if self.leg2_rtp_sock:
                try:
                    self.leg2_rtp_sock.close()
                except Exception:
                    pass
            self.leg2_rtp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            for p in range(40002, 40100, 2):
                try:
                    self.leg2_rtp_sock.bind(("0.0.0.0", p))
                    self.leg2_rtp_port = p
                    break
                except Exception:
                    continue
            print(f"[NetelipBridge] Socket RTP Leg 2 escuchando en puerto {self.leg2_rtp_port}")

            threading.Thread(target=self.leg2_rtp_receiver_loop, daemon=True).start()

            contact_ip = self.public_ip or self.local_ip
            contact_port = self.public_sip_port or self.sip_port
            sdp = (
                "v=0\r\n"
                f"o={self.sip_user} 123456 123456 IN IP4 {contact_ip}\r\n"
                "s=ForjaWeb-B2BUA\r\n"
                f"c=IN IP4 {contact_ip}\r\n"
                "t=0 0\r\n"
                f"m=audio {self.leg2_rtp_port} RTP/AVP 8 101\r\n"
                "a=rtpmap:8 PCMA/8000\r\n"
                "a=rtpmap:101 telephone-event/8000\r\n"
                "a=fmtp:101 0-16\r\n"
                "a=sendrecv\r\n"
            )
            invite = (
                f"INVITE sip:{self.leg2_target_phone}@{self.sip_domain} SIP/2.0\r\n"
                f"Via: SIP/2.0/UDP {self.local_ip}:{self.sip_port};branch=z9hG4bK-leg2-{self.leg2_cseq};rport\r\n"
                f"Max-Forwards: 70\r\n"
                f"From: <sip:{self.sip_user}@{self.sip_domain}>;tag={self.leg2_local_tag}\r\n"
                f"To: <sip:{self.leg2_target_phone}@{self.sip_domain}>\r\n"
                f"Call-ID: {self.leg2_call_id}\r\n"
                f"CSeq: {self.leg2_cseq} INVITE\r\n"
                f"Contact: <sip:{self.sip_user}@{contact_ip}:{contact_port}>\r\n"
                f"Content-Type: application/sdp\r\n"
                f"Content-Length: {len(sdp)}\r\n\r\n"
                + sdp
            )
            print("[NetelipBridge] Marcado de Leg 2 solicitado")
            self.send_sip(invite)

    def send_leg2_invite_authenticated(self, auth_header):
        self.leg2_cseq += 1
        contact_ip = self.public_ip or self.local_ip
        contact_port = self.public_sip_port or self.sip_port
        sdp = (
            "v=0\r\n"
            f"o={self.sip_user} 123456 123456 IN IP4 {contact_ip}\r\n"
            "s=ForjaWeb-B2BUA\r\n"
            f"c=IN IP4 {contact_ip}\r\n"
            "t=0 0\r\n"
            f"m=audio {self.leg2_rtp_port} RTP/AVP 8 101\r\n"
            "a=rtpmap:8 PCMA/8000\r\n"
            "a=rtpmap:101 telephone-event/8000\r\n"
            "a=fmtp:101 0-16\r\n"
            "a=sendrecv\r\n"
        )
        invite = (
            f"INVITE sip:{self.leg2_target_phone}@{self.sip_domain} SIP/2.0\r\n"
            f"Via: SIP/2.0/UDP {self.local_ip}:{self.sip_port};branch=z9hG4bK-leg2-{self.leg2_cseq};rport\r\n"
            f"Max-Forwards: 70\r\n"
            f"From: <sip:{self.sip_user}@{self.sip_domain}>;tag={self.leg2_local_tag}\r\n"
            f"To: <sip:{self.leg2_target_phone}@{self.sip_domain}>\r\n"
            f"Call-ID: {self.leg2_call_id}\r\n"
            f"CSeq: {self.leg2_cseq} INVITE\r\n"
            f"Contact: <sip:{self.sip_user}@{contact_ip}:{contact_port}>\r\n"
            f"{auth_header}\r\n"
            f"Content-Type: application/sdp\r\n"
            f"Content-Length: {len(sdp)}\r\n\r\n"
            + sdp
        )
        self.send_sip(invite)

    def send_leg2_ack(self):
        to_str = f"<sip:{self.leg2_target_phone}@{self.sip_domain}>"
        if self.leg2_remote_tag:
            to_str += f";tag={self.leg2_remote_tag}"

        ack = (
            f"ACK sip:{self.leg2_target_phone}@{self.sip_domain} SIP/2.0\r\n"
            f"Via: SIP/2.0/UDP {self.local_ip}:{self.sip_port};branch=z9hG4bK-leg2-ack-{self.leg2_cseq};rport\r\n"
            f"Max-Forwards: 70\r\n"
            f"From: <sip:{self.sip_user}@{self.sip_domain}>;tag={self.leg2_local_tag}\r\n"
            f"To: {to_str}\r\n"
            f"Call-ID: {self.leg2_call_id}\r\n"
            f"CSeq: {self.leg2_cseq} ACK\r\n"
            f"Content-Length: 0\r\n\r\n"
        )
        self.send_sip(ack)

    def send_leg2_bye(self):
        if not self.leg2_call_id or not self.leg2_target_phone:
            return
        self.leg2_cseq += 1
        to_str = f"<sip:{self.leg2_target_phone}@{self.sip_domain}>"
        if self.leg2_remote_tag:
            to_str += f";tag={self.leg2_remote_tag}"

        bye = (
            f"BYE sip:{self.leg2_target_phone}@{self.sip_domain} SIP/2.0\r\n"
            f"Via: SIP/2.0/UDP {self.local_ip}:{self.sip_port};branch=z9hG4bK-leg2-bye-{self.leg2_cseq};rport\r\n"
            f"Max-Forwards: 70\r\n"
            f"From: <sip:{self.sip_user}@{self.sip_domain}>;tag={self.leg2_local_tag}\r\n"
            f"To: {to_str}\r\n"
            f"Call-ID: {self.leg2_call_id}\r\n"
            f"CSeq: {self.leg2_cseq} BYE\r\n"
            f"Content-Length: 0\r\n\r\n"
        )
        self.send_sip(bye)
        print("[NetelipBridge] BYE enviado a Leg 2")

    def reset_leg2(self):
        self.leg2_active = False
        self.is_bridged = False
        self.ringback_active = False
        self.leg2_call_id = None
        self.leg2_remote_tag = None
        self.leg2_remote_rtp_ip = None
        self.leg2_remote_rtp_port = None
        if self.leg2_rtp_sock:
            try:
                self.leg2_rtp_sock.close()
            except Exception:
                pass
            self.leg2_rtp_sock = None

    def hangup(self):
        with self.call_lock:
            if self.inbound_service:
                self.inbound_service.hangup()
                return
            if not self.call_active or not self.call_id:
                return
            if self.call_ending:
                return
            self.call_ending = True
            if self.call_established or self.call_direction == "inbound":
                self.send_bye()
            elif self.invite_provisional:
                self.send_cancel()
            # Before a provisional response, wait for it before CANCEL.
            # Keep the line reserved until the final response arrives.

    def send_bye(self):
        remote_num = self.caller_phone if self.call_direction == "inbound" else self.callee_phone
        to_str = f"<sip:{remote_num}@{self.sip_domain}>"
        if self.remote_tag: to_str += f";tag={self.remote_tag}"
        self.cseq += 1
        bye = (
            f"BYE sip:{remote_num}@{self.sip_domain} SIP/2.0\r\n"
            f"Via: SIP/2.0/UDP {self.local_ip}:{self.sip_port};branch=z9hG4bK-bye-{self.cseq};rport\r\n"
            f"Max-Forwards: 70\r\n"
            f"From: <sip:{self.sip_user}@{self.sip_domain}>;tag={self.local_tag}\r\n"
            f"To: {to_str}\r\nCall-ID: {self.call_id}\r\n"
            f"CSeq: {self.cseq} BYE\r\nContent-Length: 0\r\n\r\n"
        )
        self.send_control(bye)

    def handle_remote_bye(self, msg, addr):
        with self.call_lock:
            if self.leg2_active:
                try:
                    self.send_leg2_bye()
                except Exception:
                    pass
                self.reset_leg2()

            lines = msg.split("\r\n")
            vias = [l for l in lines if l.lower().startswith("via:")]
            from_line = next((l for l in lines if l.lower().startswith("from:")), "")
            to_line = next((l for l in lines if l.lower().startswith("to:")), "")
            call_id_line = next((l for l in lines if l.lower().startswith("call-id:")), "")
            cseq_line = next((l for l in lines if l.lower().startswith("cseq:")), "")

            bye_ok = ["SIP/2.0 200 OK"]
            bye_ok.extend(vias)
            bye_ok.append(from_line)
            bye_ok.append(to_line)
            bye_ok.append(call_id_line)
            bye_ok.append(cseq_line)
            bye_ok.append("Content-Length: 0\r\n\r\n")
            self.send_sip("\r\n".join(bye_ok), addr)
            print("[NetelipBridge] 200 OK enviado para BYE.")
            if self.call_active:
                self.reset_call()

    def handle_remote_cancel(self, msg, addr):
        lines = msg.split("\r\n")
        vias = [l for l in lines if l.lower().startswith("via:")]
        from_line = next((l for l in lines if l.lower().startswith("from:")), "")
        to_line = next((l for l in lines if l.lower().startswith("to:")), "")
        call_id_line = next((l for l in lines if l.lower().startswith("call-id:")), "")
        cseq_line = next((l for l in lines if l.lower().startswith("cseq:")), "")

        # 1. 200 OK para el CANCEL
        cancel_ok = ["SIP/2.0 200 OK"]
        cancel_ok.extend(vias)
        cancel_ok.append(from_line)
        cancel_ok.append(to_line)
        cancel_ok.append(call_id_line)
        cancel_ok.append(cseq_line)
        cancel_ok.append("Content-Length: 0\r\n\r\n")
        self.send_sip("\r\n".join(cancel_ok), addr)

        # 2. 487 Request Terminated para el INVITE
        cseq_num = cseq_line[5:].strip().split()[0] if cseq_line else "1"
        term_headers = ["SIP/2.0 487 Request Terminated"]
        term_headers.extend(vias)
        term_headers.append(from_line)
        if ";tag=" not in to_line.lower():
            term_headers.append(f"{to_line};tag={self.local_tag or 'tag-term'}")
        else:
            term_headers.append(to_line)
        term_headers.append(call_id_line)
        term_headers.append(f"CSeq: {cseq_num} INVITE")
        term_headers.append("Content-Length: 0\r\n\r\n")
        self.send_sip("\r\n".join(term_headers), addr)
        print("[NetelipBridge] 200 OK (CANCEL) y 487 (INVITE) enviados.")
        self.reset_call()

    def reset_call(self):
        if not self.call_active:
            return
        self.notify_node_call_end()
        self.call_active = False
        self.call_established = False
        self.start_notified = False
        self.call_ending = False
        self.invite_cseq = 0
        self.last_invite_request = ""
        self.last_control_packet = None
        self.session_id = None
        self.pending_session_id = None
        self.call_started_at = 0.0
        self.call_id = None
        self.remote_tag = None
        self.local_tag = None
        self.caller_phone = None
        self.callee_phone = None
        self.remote_rtp_ip = None
        self.remote_rtp_port = None
        self.last_200_ok = None
        self.ringback_active = False
        self.reset_leg2()
        with self.outbound_audio_lock:
            self.turn_segments.clear()
            self.active_segment = None
            self.flushed_turn_ids.clear()
            self.last_actual_rtp_send_time = 0.0

    def send_tcp(self, pkt):
        """Envía un paquete a Node.js de forma segura entre hilos (evita intercalar bytes)."""
        sock = self.tcp_sock
        if not sock:
            return False
        with self.tcp_send_lock:
            sock.sendall(pkt)
        return True

    def notify_node_call_start(self):
        with self.outbound_audio_lock:
            self.turn_segments.clear()
            self.active_segment = None
            self.flushed_turn_ids.clear()
            self.last_actual_rtp_send_time = 0.0
        if not self.tcp_sock:
            self.connect_tcp_bridge()
        if self.tcp_sock:
            try:
                session_id = self.session_id or self.pending_session_id or f"netelip_{int(time.time())}"
                self.session_id = session_id
                self.pending_session_id = None
                payload = json.dumps({
                    "sessionId": session_id,
                    "direction": self.call_direction,
                    "phone": self.caller_phone if self.call_direction == "inbound" else self.callee_phone,
                    "company": "Cliente Netelip" if self.call_direction == "outbound" else "Llamada Entrante",
                    "codec": "pcma"
                }).encode("utf-8")
                self.send_tcp(encode_packet(PACKET_CALL_START, 0, payload))
                print("[NetelipBridge] CALL_START notificado al motor local; codec=pcma")
            except Exception as e:
                print(f"[NetelipBridge] Error notificando CALL_START a Node.js: {type(e).__name__}")

    def notify_node_call_end(self):
        if self.tcp_sock:
            try:
                payload = json.dumps({"sessionId": self.session_id or self.pending_session_id, "reason": self.terminal_reason or "hangup"}).encode()
                self.send_tcp(encode_packet(PACKET_CALL_END, 0, payload))
                print(f"[NetelipBridge] -> Notificado PACKET_CALL_END a Node.js")
            except Exception as e:
                pass

    # ==================== AUDIO RTP ====================

    def rtp_receiver_loop(self):
        """Recibe audio G.711 A-law desde Netelip y lo reenvía tal cual (sin remuestrear) a Node.js"""
        while self.running:
            try:
                data, addr = self.rtp_sock.recvfrom(2048)
                if not self.call_active or len(data) <= 12:
                    continue

                # Solo aceptamos PCMA (PT 8); descartamos DTMF (telephone-event), RTCP y ruido de confort
                if (data[1] & 0x7F) != 8:
                    continue
                if self.remote_rtp_ip and addr[0] != self.remote_rtp_ip:
                    continue
                if self.inbound_service and (not self.call_established or addr != (self.remote_rtp_ip, self.remote_rtp_port)):
                    continue
                self.rtp_packets_received += 1
                self.rtp_totals["received"] += 1

                # Aprender el socket RTP real del operador ÚNICAMENTE a partir de tramas PCMA legítimas
                # (Evita que paquetes RTCP en puertos impares desvíen el flujo de audio saliente)
                if addr and (self.remote_rtp_ip != addr[0] or self.remote_rtp_port != addr[1]):
                    self.remote_rtp_ip = addr[0]
                    self.remote_rtp_port = addr[1]

                # Si la llamada está enlazada B2BUA con Miguel (Leg 2), reenviar el paquete RTP directamente a Miguel
                if self.is_bridged and self.leg2_rtp_sock and self.leg2_remote_rtp_ip and self.leg2_remote_rtp_port:
                    try:
                        self.leg2_rtp_sock.sendto(data, (self.leg2_remote_rtp_ip, self.leg2_remote_rtp_port))
                    except Exception:
                        pass
                    continue

                # Cabecera RTP: 12 bytes + CSRC + extensión + padding
                header_len = 12 + 4 * (data[0] & 0x0F)
                if data[0] & 0x10:
                    if len(data) < header_len + 4:
                        continue
                    ext_words = (data[header_len + 2] << 8) | data[header_len + 3]
                    header_len += 4 + 4 * ext_words
                end = len(data)
                if data[0] & 0x20:
                    end -= data[-1]
                payload = data[header_len:end]
                if not payload:
                    continue

                # A-law 8kHz crudo hacia Node.js (OpenAI Realtime acepta audio/pcma nativo)
                self.send_tcp(encode_packet(PACKET_AUDIO, 0, payload))

            except Exception as e:
                if self.running and self.call_active:
                    self.rtp_receive_errors += 1
                    self.rtp_totals["receive_errors"] += 1

    def rtp_sender_loop(self):
        """Envía a Netelip el A-law 8kHz nativo de OpenAI con cadencia de 20ms, baja latencia y gestión estricta por turnos"""
        FRAME = 160  # 20ms a 8kHz A-law = 160 bytes
        silence_frame = b"\xd5" * FRAME  # Silencio estándar ITU-T G.711 A-law (0xD5)
        PREBUFFER_BYTES = FRAME * 18     # 360ms de pre-buffer inicial (18 tramas para absorber pausas de generación)
        FRAME_DURATION = 0.020           # 20 ms nominal

        # Resolución de temporizador de 1ms en Windows y prioridad alta del hilo
        try:
            import ctypes
            ctypes.windll.winmm.timeBeginPeriod(1)
            k32 = ctypes.windll.kernel32
            k32.SetThreadPriority.argtypes = [ctypes.c_void_p, ctypes.c_int]
            k32.SetThreadPriority.restype = ctypes.c_bool
            k32.SetThreadPriority(k32.GetCurrentThread(), 2)
        except Exception:
            pass

        playing = False
        starve_start = 0.0
        in_starve_event = False
        starve_count = 0
        starve_total_s = 0.0

        next_packet_time = time.perf_counter()

        while self.running:
            now = time.perf_counter()
            wait_time = next_packet_time - now
            if wait_time > 0:
                time.sleep(wait_time)

            now = time.perf_counter()
            next_packet_time = next_packet_time + FRAME_DURATION
            if now - next_packet_time > 0.040:
                next_packet_time = now + FRAME_DURATION

            if not self.call_active or not self.remote_rtp_ip or not self.remote_rtp_port:
                time.sleep(0.01)
                playing = False
                starve_start = 0.0
                in_starve_event = False
                starve_count = 0
                starve_total_s = 0.0
                continue

            # Si la llamada está enlazada B2BUA o suena ringback, pausar
            if self.is_bridged or self.ringback_active:
                time.sleep(0.02)
                continue

            payload = silence_frame
            now = time.perf_counter()

            with self.outbound_audio_lock:
                # 1. Si no hay segmento activo o el activo está terminado/vaciado/flushed:
                if self.active_segment is None or (self.active_segment.flushed and len(self.active_segment.buffer) == 0) or (self.active_segment.turn_ended and len(self.active_segment.buffer) == 0):
                    if self.active_segment is not None:
                        # Si terminó normalmente y no se había notificado drained
                        if self.active_segment.turn_ended and not self.active_segment.flushed and not self.active_segment.drained_notified:
                            self.send_tcp(encode_packet(PACKET_PLAYBACK_DRAINED, self.active_segment.turn_id))
                            self.active_segment.drained_notified = True
                            played_ms = int(self.active_segment.played_bytes / 8)
                            starve_ms = int(starve_total_s * 1000)
                            print(f"[RTP Telemetría] 🏁 Turno #{self.active_segment.turn_id} finalizado: {played_ms}ms reproducidos. Underruns: {starve_count}. Duración underrun: {starve_ms}ms.")
                        elif self.active_segment.flushed:
                            if self.active_segment.played_bytes > 0:
                                played_ms = int(self.active_segment.played_bytes / 8)
                                print(f"[RTP Telemetría] ⚡ Turno #{self.active_segment.turn_id} interrumpido por flush ({played_ms}ms reproducidos).")

                    # Avanzar al siguiente segmento en cola si existe
                    if self.turn_segments:
                        self.active_segment = self.turn_segments.popleft()
                        playing = False
                        starve_start = 0.0
                        in_starve_event = False
                        starve_count = 0
                        starve_total_s = 0.0
                    else:
                        self.active_segment = None
                        playing = False
                        starve_start = 0.0
                        in_starve_event = False
                        starve_count = 0
                        starve_total_s = 0.0

                # 2. Si tenemos un segmento activo, procesar su audio
                seg = self.active_segment
                if seg is not None and not seg.flushed:
                    n = len(seg.buffer)

                    if not playing:
                        if n >= PREBUFFER_BYTES or (seg.turn_ended and n > 0):
                            playing = True
                            if not seg.started_notified:
                                self.send_tcp(encode_packet(PACKET_PLAYBACK_STARTED, seg.turn_id))
                                seg.started_notified = True

                    if playing:
                        if n >= FRAME:
                            payload = bytes(seg.buffer[:FRAME])
                            del seg.buffer[:FRAME]
                            seg.played_bytes += FRAME
                            if in_starve_event:
                                starve_total_s += (now - starve_start)
                                in_starve_event = False
                                starve_start = 0.0
                        else:
                            if not seg.turn_ended:
                                # Audio aún en generación por OpenAI: emitir trama de confort si el buffer temporalmente está bajo (<160b)
                                if starve_start == 0.0:
                                    starve_start = now
                                    starve_count += 1
                                    in_starve_event = True
                                payload = silence_frame
                            else:
                                # Fin de generación alcanzado. Emitir último fragmento con relleno de confort
                                if n > 0:
                                    payload = bytes(seg.buffer) + b"\xd5" * (FRAME - n)
                                    seg.played_bytes += n
                                    seg.buffer.clear()
                                playing = False
                                if in_starve_event:
                                    starve_total_s += (now - starve_start)
                                    in_starve_event = False
                                starve_start = 0.0
                                if not seg.drained_notified and not seg.flushed:
                                    self.send_tcp(encode_packet(PACKET_PLAYBACK_DRAINED, seg.turn_id))
                                    seg.drained_notified = True
                                    played_ms = int(seg.played_bytes / 8)
                                    starve_ms = int(starve_total_s * 1000)
                                    print(f"[RTP Telemetría] 🏁 Turno #{seg.turn_id} finalizado: {played_ms}ms reproducidos. Underruns: {starve_count}. Duración underrun: {starve_ms}ms.")

            # Enviar la trama a través del emisor unificado con pacing estricto
            self.send_rtp_frame(payload)

    def tcp_receiver_loop(self):
        """Recibe audio y eventos desde Node.js (OpenAI Realtime) estructurados por turno"""
        accum = bytearray()
        while self.running:
            try:
                if not self.tcp_sock:
                    time.sleep(2)
                    accum.clear()
                    self.connect_tcp_bridge()
                    continue

                data = self.tcp_sock.recv(65536)
                if not data:
                    print("[NetelipBridge] Conexión TCP con Node.js cerrada. Reconectando en 2s...")
                    accum.clear()
                    time.sleep(2)
                    self.connect_tcp_bridge()
                    continue

                accum.extend(data)
                while len(accum) >= 4:
                    pkt_type = accum[0]
                    turn_id = accum[1]
                    length = (accum[2] << 8) | accum[3]
                    total_len = 4 + length

                    if len(accum) < total_len:
                        break

                    payload = bytes(accum[4:total_len])
                    del accum[:total_len]

                    if pkt_type == PACKET_AUDIO:
                        with self.outbound_audio_lock:
                            if turn_id in self.flushed_turn_ids:
                                continue
                            # Buscar si ya existe segmento para este turn_id
                            target_seg = None
                            if self.active_segment and self.active_segment.turn_id == turn_id:
                                target_seg = self.active_segment
                            else:
                                for s in self.turn_segments:
                                    if s.turn_id == turn_id:
                                        target_seg = s
                                        break
                            if target_seg is None:
                                target_seg = TurnAudioSegment(turn_id)
                                self.turn_segments.append(target_seg)
                            target_seg.buffer.extend(payload)

                    elif pkt_type == PACKET_TURN_END:
                        with self.outbound_audio_lock:
                            if self.active_segment and self.active_segment.turn_id == turn_id:
                                self.active_segment.turn_ended = True
                            for s in self.turn_segments:
                                if s.turn_id == turn_id:
                                    s.turn_ended = True

                    elif pkt_type == PACKET_FLUSH:
                        with self.outbound_audio_lock:
                            self.flushed_turn_ids.add(turn_id)
                            # Purgar segmento activo si coincide o es anterior
                            if self.active_segment and self.active_segment.turn_id <= turn_id:
                                self.active_segment.flushed = True
                                self.active_segment.buffer.clear()
                            # Purgar segmentos en cola con turn_id <= turn_id purgado
                            kept = collections.deque()
                            for s in self.turn_segments:
                                if s.turn_id <= turn_id:
                                    s.flushed = True
                                    s.buffer.clear()
                                else:
                                    kept.append(s)
                            self.turn_segments = kept

                    elif pkt_type == PACKET_CALL_END:
                        if self.inbound_service:
                            try:
                                control = json.loads(payload)
                                if control.get("sessionId") != self.session_id:
                                    continue
                                if self.inbound_service.dialog and control.get("reason") == "completed":
                                    self.inbound_service.dialog["completion"] = "finalizada"
                            except (ValueError, AttributeError):
                                continue
                        print("[NetelipBridge] Node.js solicitó colgar la llamada.")
                        self.hangup()

            except Exception as e:
                if self.running:
                    accum.clear()
                    time.sleep(2)
                    self.connect_tcp_bridge()

    def udp_control_listener(self):
        raise RuntimeError("Control UDP deshabilitado; use HTTP autenticado")
        """Escucha comandos desde el servidor Web / CRM en UDP 8085 con protección SO_REUSEADDR"""
        udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            try:
                udp_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            except Exception:
                pass
            udp_sock.bind(("127.0.0.1", CONTROL_UDP_PORT))
            print(f"[NetelipBridge] Control UDP escuchando en 127.0.0.1:{CONTROL_UDP_PORT}")
            while self.running:
                data, _ = udp_sock.recvfrom(512)
                cmd_str = data.decode("utf-8").strip()
                if cmd_str.startswith("DIAL:"):
                    parts = cmd_str.split(":", 3)
                    phone = parts[1]
                    company = parts[2] if len(parts) > 2 else "Cliente"
                    session_id = parts[3] if len(parts) > 3 and parts[3] else None
                    self.dial(phone, company, session_id)
                elif cmd_str == "HANGUP" or cmd_str == "END":
                    self.hangup()
                elif cmd_str.startswith("TRANSFER:"):
                    target = cmd_str.split(":", 1)[1]
                    self.transfer_call(target)
                elif cmd_str == "STATUS":
                    print(f"[NetelipBridge Status] Registrado: {self.registered}, Llamada Activa: {self.call_active}")
        except Exception as e:
            print(f"[NetelipBridge] Error en control UDP: {type(e).__name__}")
        finally:
            udp_sock.close()

    def http_control_listener(self):
        """Escucha órdenes estructuradas autenticadas e idempotentes en HTTP local 127.0.0.1:8086"""
        bridge_inst = self
        class ControlHttpHandler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def _send_json(self, status_code, data):
                body = json.dumps(data).encode("utf-8")
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)

            def _check_auth(self):
                secret = bridge_inst.control_secret
                if not secret:
                    return False
                auth_header = self.headers.get("Authorization", "").strip()
                return hmac.compare_digest(auth_header, f"Bearer {secret}")

            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
                self.end_headers()

            def do_GET(self):
                if self.path in ("/api/v1/status", "/status"):
                    if not self._check_auth():
                        return self._send_json(401, {"error": "Unauthorized"})
                    data = {
                        "registered": bridge_inst.registration_valid(),
                        "registration_error": bridge_inst.register_error,
                        "registration_ttl_seconds": max(0, int(bridge_inst.register_expires_at - time.monotonic())),
                        "call_active": bridge_inst.call_active,
                        "call_ending": bridge_inst.call_ending,
                        "established": bridge_inst.call_established,
                        "last_result": bridge_inst.terminal_reason,
                        "session_id": bridge_inst.session_id,
                        "pilot": bridge_inst.pilot,
                        "current_phone": bridge_inst.callee_phone or bridge_inst.caller_phone or "",
                        "rtp_packets_sent": getattr(bridge_inst, "rtp_packets_sent", 0),
                        "rtp_packets_received": bridge_inst.rtp_packets_received,
                        "rtp_send_errors": bridge_inst.rtp_send_errors,
                        "rtp_receive_errors": bridge_inst.rtp_receive_errors,
                        "rtp_totals": dict(bridge_inst.rtp_totals),
                        "rtp_jitter_mean_ms": round(sum(bridge_inst.rtp_jitter_samples[-50:]) / max(1, len(bridge_inst.rtp_jitter_samples[-50:])), 2) if getattr(bridge_inst, "rtp_jitter_samples", None) else 0.0,
                        "buffer_underruns": getattr(bridge_inst, "buffer_underruns", 0),
                        "buffer_overflows": getattr(bridge_inst, "buffer_overflows", 0)
                    }
                    return self._send_json(200, data)
                self._send_json(404, {"error": "Not Found"})

            def do_POST(self):
                if self.path == "/api/v1/commands":
                    if not self._check_auth():
                        return self._send_json(401, {"error": "Unauthorized"})
                    try:
                        content_len = int(self.headers.get("Content-Length", 0))
                        if content_len < 1 or content_len > 16384:
                            raise ValueError("Tamaño de solicitud inválido")
                        raw_body = self.rfile.read(content_len).decode("utf-8")
                        req = json.loads(raw_body)
                        if not isinstance(req, dict) or any(not isinstance(req.get(k, ""), str) for k in ("command", "call_id", "phone", "company", "target_phone")):
                            raise ValueError("Formato de orden inválido")
                    except Exception as e:
                        return self._send_json(400, {"error": f"JSON inválido: {e}"})

                    cmd = req.get("command", "").lower().strip()
                    call_id = req.get("call_id", "").strip()
                    phone = req.get("phone", "").strip()
                    company = req.get("company", "Cliente").strip()

                    if cmd == "dial":
                        try:
                            phone = bridge_inst.validate_destination(phone)
                            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,160}", call_id):
                                raise ValueError("call_id válido requerido")
                            with bridge_inst.call_lock:
                                if not bridge_inst.registration_valid():
                                    return self._send_json(503, {"status": "rejected_not_registered"})
                                if bridge_inst.call_active:
                                    return self._send_json(409, {"status": "rejected_busy"})
                                if not bridge_inst.record_call_id(call_id, json.dumps([phone, company], ensure_ascii=True)):
                                    return self._send_json(200, {"status": "duplicate_ignored", "idempotent_replay": True})
                                bridge_inst.dial(phone, company, call_id)
                            return self._send_json(202, {"status": "accepted", "call_id": call_id})
                        except ValueError as e:
                            return self._send_json(400, {"error": str(e)})
                        except Exception:
                            return self._send_json(503, {"error": "No se pudo reservar o ejecutar la llamada. No se reintentará automáticamente."})

                    elif cmd == "hangup":
                        bridge_inst.hangup()
                        return self._send_json(200, {"status": "hangup_requested"})

                    elif cmd == "transfer":
                        if bridge_inst.pilot:
                            return self._send_json(403, {"error": "Transferencias deshabilitadas en el piloto"})
                        target = req.get("target_phone") or req.get("phone") or bridge_inst.transfer_phone
                        bridge_inst.transfer_call(target)
                        return self._send_json(202, {"status": "transfer_initiated", "target_phone": target})

                    else:
                        return self._send_json(400, {"error": f"Comando no reconocido: {cmd}"})

                self._send_json(404, {"error": "Not Found"})

        try:
            httpd = HTTPServer(("127.0.0.1", 8086), ControlHttpHandler)
            print("[NetelipBridge] 🌐 API HTTP de Control escuchando en http://127.0.0.1:8086")
            httpd.serve_forever()
        except Exception as e:
            print(f"[NetelipBridge] Error en servidor HTTP de control: {type(e).__name__}")

if __name__ == "__main__":
    bridge = NetelipSipBridge()
    try:
        bridge.start()
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("[NetelipBridge] Deteniendo centralita...")
        bridge.running = False
