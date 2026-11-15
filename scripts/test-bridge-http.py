import unittest
import json
import urllib.request
import urllib.error
import threading
import time
import os
import sys

# Ensure parent directory is in path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import importlib.util
bridge_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bridge", "netelip-bridge.py")
spec = importlib.util.spec_from_file_location("netelip_bridge", bridge_path)
netelip_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(netelip_module)
NetelipSipBridge = netelip_module.NetelipSipBridge

class TestBridgeHttpControl(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = NetelipSipBridge()
        cls.bridge.control_secret = "test-secret-12345"
        cls.bridge.registered = True
        cls.bridge.call_active = False

        # Iniciar listener HTTP en hilo daemon
        cls.server_thread = threading.Thread(target=cls.bridge.http_control_listener, daemon=True)
        cls.server_thread.start()
        time.sleep(0.5)

    def test_01_unauthorized_request(self):
        req = urllib.request.Request("http://127.0.0.1:8086/api/v1/status")
        try:
            urllib.request.urlopen(req)
            self.fail("Expected HTTP 401 Unauthorized")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 401)

    def test_02_authorized_status(self):
        req = urllib.request.Request(
            "http://127.0.0.1:8086/api/v1/status",
            headers={"Authorization": "Bearer test-secret-12345"}
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertIn("registered", data)
            self.assertIn("call_active", data)
            self.assertEqual(data["registered"], True)

    def test_03_idempotency_duplicate_dial(self):
        call_id = f"test_call_idem_{int(time.time()*1000)}"
        payload = json.dumps({
            "command": "dial",
            "phone": "600000000",
            "company": "Test Idem",
            "call_id": call_id
        }).encode("utf-8")

        # Mock out dial method so it doesn't send real SIP packets
        self.bridge.dial = lambda phone, company, cid: None

        # Primera llamada -> aceptada (202)
        req1 = urllib.request.Request(
            "http://127.0.0.1:8086/api/v1/commands",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer test-secret-12345"
            }
        )
        with urllib.request.urlopen(req1) as resp1:
            self.assertEqual(resp1.status, 202)
            data1 = json.loads(resp1.read().decode("utf-8"))
            self.assertEqual(data1.get("status"), "accepted")
            self.assertEqual(data1.get("call_id"), call_id)

        # Segunda llamada con MISMO call_id -> 200 duplicate_ignored
        req2 = urllib.request.Request(
            "http://127.0.0.1:8086/api/v1/commands",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer test-secret-12345"
            }
        )
        with urllib.request.urlopen(req2) as resp2:
            self.assertEqual(resp2.status, 200)
            data2 = json.loads(resp2.read().decode("utf-8"))
            self.assertEqual(data2.get("status"), "duplicate_ignored")
            self.assertEqual(data2.get("idempotent_replay"), True)

    def test_04_hangup_command(self):
        payload = json.dumps({"command": "hangup"}).encode("utf-8")
        self.bridge.hangup = lambda: None

        req = urllib.request.Request(
            "http://127.0.0.1:8086/api/v1/commands",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer test-secret-12345"
            }
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(data.get("status"), "hangup_requested")

if __name__ == "__main__":
    unittest.main()
