"""Offline restoration of backup files and SQLite; never starts copied application."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
from contextlib import closing
import sys

spec=importlib.util.spec_from_file_location('pilot_backup',Path(__file__).with_name('pilot-backup.py'))
backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)

def verify_and_restore(root):
    root=root.resolve(strict=True)
    manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('status') == 'incomplete': raise ValueError('Incomplete backup operation')
    if root.parent.name!='respaldos-locales': raise ValueError('Only approved local backup operation directories')
    for item in manifest['files']:
        path=root/backup.safe_member(item['path'])
        if path.is_symlink() or path.resolve().is_relative_to(root) is False: raise ValueError('Unsafe source')
        if backup.digest(path.read_bytes())!=item['sha256']: raise ValueError('Backup hash mismatch')
    image=manifest['image']
    if image['included']:
        path=root/'image.tar'
        with path.open('rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=image['sha256']: raise ValueError('Image hash mismatch')
        backup.verify_image_archive(path,image['imageId'])
    dest=root/'restore-isolated'
    backup.private_dir(dest)
    sqlite_count=0
    # Restore original files under a private, non-executable archive tree. Do not
    # import application modules, invoke Docker, restore ports or launch processes.
    for item in manifest['files']:
        member=backup.safe_member(item['path'])
        target=dest/'original'/member
        target.parent.mkdir(parents=True,exist_ok=True)
        content=(root/member).read_bytes()
        with target.open('xb') as f: f.write(content)
        if backup.digest(target.read_bytes())!=item['sha256']: raise ValueError('Restored hash mismatch')
        if member.parts[0]=='data' and target.suffix in ['.sqlite','.sqlite3','.db']:
            with closing(sqlite3.connect(target.resolve().as_uri()+'?mode=ro',uri=True)) as db:
                if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok': raise ValueError('Restored SQLite invalid')
            sqlite_count+=1
        elif member.parts[0]=='data' and target.suffix=='.json':
            json.loads(content)
    # A separate safe fixture can be mounted in an explicitly reviewed network-none
    # runtime later; it contains no credentials and no copied customer data.
    safe=dest/'safe-runtime';safe.mkdir()
    (safe/'runtime-policy.json').write_text(json.dumps({'realCallsEnabled':False,'realWhatsAppEnabled':False}),encoding='utf-8')
    (safe/'config.json').write_text('{}',encoding='utf-8')
    report={'status':'offline_file_restore_verified','files':len(manifest['files']),'sqliteDatabases':sqlite_count,
        'imageArchiveVerified':image['included'],'networkUsed':False,'applicationStarted':False,'realCallsEnabled':False,
        'fullApplicationRestorationTested':False,'limitation':'Verified private restored files, JSON and SQLite integrity. Did not start application or validate SIP/provider recovery.'}
    (dest/'result.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('operation',type=Path);args=parser.parse_args()
    try: print(json.dumps(verify_and_restore(args.operation)))
    except Exception as exc:
        print('Offline restore failed: '+type(exc).__name__+'. Private contents suppressed.',file=sys.stderr);sys.exit(1)
