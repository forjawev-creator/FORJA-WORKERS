"""Synthetic recovery fixtures only. No SSH, Docker or production files."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
from contextlib import closing
import tarfile
import tempfile
import unittest
from unittest.mock import patch

def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

backup=load('backup_test','pilot-backup.py')
restore=load('restore_test','pilot-restore-check.py')

class Recovery(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='forja-backup-synthetic-')
        self.root=Path(self.temp.name).resolve()
        self.operation=self.root/'respaldos-locales'/'2026-11-21-synthetic'
        self.operation.mkdir(parents=True)
        with closing(sqlite3.connect(':memory:')) as db:
            db.execute('CREATE TABLE test (id INTEGER PRIMARY KEY)');db.execute('INSERT INTO test VALUES (1)')
            payload=db.serialize()
        self.payload={'files':{
            'data/config.json':base64.b64encode(b'{"synthetic":true}').decode(),
            'data/voice-control.sqlite3':base64.b64encode(payload).decode(),
            'private/runtime.env':base64.b64encode(b'SYNTHETIC=1\n').decode(),
            'code/version.txt':base64.b64encode(b'fixture').decode()}}
        self.records=backup.save_snapshot(self.payload,self.operation)
        (self.operation/'manifest.json').write_text(json.dumps({'files':self.records,'image':{'included':False}}))

    def tearDown(self):
        # Cleanup scope is validated before TemporaryDirectory recursively deletes it.
        assert self.operation.resolve().is_relative_to(self.root)
        assert self.root.name.startswith('forja-backup-synthetic-')
        self.temp.cleanup()

    def test_restore_verifies_data_without_network_or_subprocess(self):
        with patch('subprocess.run',side_effect=AssertionError('No external processes')):
            # Avoid OS ACL command in test fixture; production uses private_dir.
            with patch.object(restore.backup,'private_dir',side_effect=lambda p:p.mkdir(exist_ok=False)):
                report=restore.verify_and_restore(self.operation)
        self.assertEqual(report['sqliteDatabases'],1)
        self.assertFalse(report['networkUsed'])
        self.assertFalse(report['fullApplicationRestorationTested'])
        policy=json.loads((self.operation/'restore-isolated/safe-runtime/runtime-policy.json').read_text())
        self.assertFalse(policy['realCallsEnabled'])
        self.assertFalse(policy['realWhatsAppEnabled'])

    def test_modified_backup_rejected_before_restore(self):
        (self.operation/'data/config.json').write_text('{"changed":true}')
        with self.assertRaises(ValueError):restore.verify_and_restore(self.operation)
        self.assertFalse((self.operation/'restore-isolated').exists())

    def test_path_traversal_rejected(self):
        for name in ['../private.env','/tmp/private.env','data/../../private.env','C:/private.env','data\\..\\bad']:
            with self.assertRaises(ValueError):backup.safe_member(name)

    def test_existing_files_cannot_be_overwritten(self):
        with self.assertRaises(FileExistsError):backup.save_snapshot(self.payload,self.operation)

    def test_incomplete_manifest_rejected(self):
        backup.write_manifest(self.operation, {'status':'incomplete','files':self.records,'image':{'included':False}})
        with self.assertRaises(ValueError): restore.verify_and_restore(self.operation)
        self.assertFalse((self.operation/'restore-isolated').exists())

    def test_image_timeout_bounds(self):
        self.assertEqual(backup.image_timeout('7200'),7200)
        for value in ['0','59','86401']:
            with self.assertRaises(Exception): backup.image_timeout(value)

    def test_image_identity_and_readable_layer(self):
        p=self.root/'image.tar';config=json.dumps({'architecture':'amd64','os':'linux','rootfs':{'type':'layers','diff_ids':['sha256:'+hashlib.sha256(b'fake layer').hexdigest()]}}).encode();image_id='sha256:'+hashlib.sha256(config).hexdigest()
        entries={'config.json':config,'layer.tar':b'fake layer','manifest.json':json.dumps([{'Config':'config.json','Layers':['layer.tar']}]).encode()}
        with tarfile.open(p,'w') as out:
            for name,data in entries.items():
                info=tarfile.TarInfo(name);info.size=len(data);out.addfile(info,io.BytesIO(data))
        backup.verify_image_archive(p,image_id)
        with self.assertRaises(ValueError):backup.verify_image_archive(p,'sha256:'+'0'*64)

if __name__=='__main__':unittest.main()
