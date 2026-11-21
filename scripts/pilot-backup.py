"""Explicit private backup, streamed over pinned SSH; never writes remote files."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
from contextlib import closing
import subprocess
import sys
import tarfile

HOST = '46.224.56.125'
HOST_FINGERPRINT = 'SHA256:nw5apxIsMJuFtZs0DenK0C0gya8WNWMTTYszylA23cA'
CONTAINER = 'bot-llamadas-piloto'

# This program runs on the server through stdin. All intermediate material is RAM.
REMOTE = r'''
import base64, hashlib, json, pathlib, sqlite3, subprocess
from contextlib import closing
name = 'bot-llamadas-piloto'
def run(args):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=60)
def state():
    code = "fetch('http://127.0.0.1:3012/api/status').then(r=>{if(!r.ok)throw Error();return r.json()}).then(s=>console.log(JSON.stringify({active:s.active,ending:s.ending,busy:s.busy,uncertain:s.uncertain}))).catch(()=>process.exit(2))"
    value = json.loads(run(['docker','exec',name,'node','-e',code]))
    if any(value.get(k) is not False for k in ['active','ending','busy','uncertain']):
        raise RuntimeError('Pilot is not confirmed idle')
    return value
def read_data():
    root = pathlib.Path('/opt/bot-llamadas-piloto/data')
    result = {}
    for p in sorted(root.rglob('*')):
        if p.is_symlink(): raise RuntimeError('Symlink in private data')
        if not p.is_file() or p.name.endswith(('-wal','-shm','-journal')): continue
        relative = 'data/' + p.relative_to(root).as_posix()
        if p.suffix in ['.sqlite','.sqlite3','.db']:
            with closing(sqlite3.connect(p.as_uri()+'?mode=ro', uri=True)) as source:
                with closing(sqlite3.connect(':memory:')) as memory:
                    source.backup(memory)
                    if memory.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise RuntimeError('Invalid SQLite snapshot')
                    data = memory.serialize()
        else:
            data = p.read_bytes()
        result[relative] = data
    result['private/runtime.env'] = pathlib.Path('/opt/bot-llamadas-piloto/runtime.env').read_bytes()
    return result
first_state = state()
first = read_data()
inspect = json.loads(run(['docker','inspect',name]))[0]
if not any(m['Destination']=='/pilot/data' and m['Source']=='/opt/bot-llamadas-piloto/data' for m in inspect['Mounts']):
    raise RuntimeError('Pilot data mount differs from audited location')
if 'data/config.json' not in first:
    raise RuntimeError('Missing pilot configuration')
first['private/container-inspect.json'] = json.dumps(inspect,indent=2).encode()
collector = """import pathlib,json,base64
root=pathlib.Path('/pilot'); out={}
for name in ['dist','bridge','public','brain']:
 for p in sorted((root/name).rglob('*')):
  if p.is_symlink(): raise RuntimeError('Unexpected source symlink')
  if p.is_file(): out['code/'+p.relative_to(root).as_posix()]=base64.b64encode(p.read_bytes()).decode()
for name,p in [('package.json',root/'package.json'),('package-lock.json',pathlib.Path('/app/package-lock.json'))]:
 if p.is_file(): out['code/'+name]=base64.b64encode(p.read_bytes()).decode()
print(json.dumps(out))
"""
code = json.loads(run(['docker','exec',name,'python','-c',collector]))
second = read_data()
last_state = state()
after = json.loads(run(['docker','inspect',name]))[0]
before_without_inspect = {k:v for k,v in first.items() if k!='private/container-inspect.json'}
if before_without_inspect != second or inspect['Id'] != after['Id'] or inspect['Image'] != after['Image'] or inspect['State']['StartedAt'] != after['State']['StartedAt']:
    raise RuntimeError('State changed while snapshotting; retry only after review')
files = {k:base64.b64encode(v).decode() for k,v in first.items()}
files.update(code)
print(json.dumps({'imageId':inspect['Image'],'containerId':inspect['Id'],'startedAt':inspect['State']['StartedAt'],'idleBefore':first_state,'idleAfter':last_state,'files':files}))
'''

def digest(data):
    return hashlib.sha256(data).hexdigest()

_verifier_spec = importlib.util.spec_from_file_location('image_archive_verifier', Path(__file__).with_name('image-archive-verifier.py'))
_verifier_module = importlib.util.module_from_spec(_verifier_spec)
_verifier_spec.loader.exec_module(_verifier_module)
verify_image_archive = _verifier_module.verify_image_archive


def private_dir(path):
    path.mkdir(parents=True, exist_ok=False)
    if os.name == 'nt':
        identity = os.environ.get('USERDOMAIN', '') + '\\' + os.environ['USERNAME']
        subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r', identity+':(OI)(CI)F', 'SYSTEM:(OI)(CI)F'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        path.chmod(0o700)

def safe_member(name):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name or not p.parts or p.parts[0] not in ('data','private','code'):
        raise ValueError('Unsafe backup member')
    return Path(*p.parts)

def save_snapshot(payload, destination):
    records = []
    for name, encoded in payload['files'].items():
        target = destination / safe_member(name)
        data = base64.b64decode(encoded, validate=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        if os.name != 'nt': target.chmod(0o600)
        sha = digest(data)
        if digest(target.read_bytes()) != sha: raise RuntimeError('Local hash verification failed')
        records.append({'path':name,'sha256':sha,'bytes':len(data)})
    return records

def pinned_ssh(known_hosts):
    # StrictHostKeyChecking prevents substitution; independently check expected identity.
    found = subprocess.run(['ssh-keygen','-F',HOST,'-f',str(known_hosts)], capture_output=True, check=True).stdout
    fingerprints = subprocess.run(['ssh-keygen','-lf','-'], input=found, capture_output=True, check=True).stdout.decode()
    if HOST_FINGERPRINT not in fingerprints: raise RuntimeError('Pinned server identity not present')
    return ['ssh','-C','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','HostKeyAlgorithms=ssh-ed25519','-o','ConnectTimeout=15','-o','UserKnownHostsFile='+str(known_hosts),'root@'+HOST]

def image_timeout(value):
    seconds = int(value)
    if not 60 <= seconds <= 86400:
        raise argparse.ArgumentTypeError('Image timeout must be 60..86400 seconds')
    return seconds


def write_manifest(destination, manifest):
    temporary = destination / 'manifest.pending.json'
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(manifest, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(destination / 'manifest.json')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup-root',type=Path,required=True)
    parser.add_argument('--operation',required=True)
    parser.add_argument('--known-hosts',type=Path,default=Path.home()/'.ssh/known_hosts')
    parser.add_argument('--include-image',action='store_true',help='Stream immutable Docker image to local disk; needed for server-loss recovery')
    parser.add_argument('--image-timeout-seconds',type=image_timeout,default=7200)
    args=parser.parse_args()
    root=args.backup_root.resolve(strict=True)
    if root.name!='respaldos-locales' or root.drive.startswith('\\\\') or not re.fullmatch(r'\d{4}-\d{2}-\d{2}-[a-zA-Z0-9_-]+',args.operation):
        raise ValueError('Use approved respaldos-locales/YYYY-MM-DD-description destination')
    ssh=pinned_ssh(args.known_hosts.resolve(strict=True))
    dest=root/args.operation
    private_dir(dest)
    # stderr can contain private diagnostic information: never relay it to a report.
    result=subprocess.run(ssh+['python3','-'],input=REMOTE.encode(),capture_output=True,timeout=180)
    if result.returncode: raise RuntimeError('Remote snapshot failed; no private diagnostics printed')
    payload=json.loads(result.stdout)
    records=save_snapshot(payload,dest)
    image={'included':False,'restorationVerified':False}
    manifest={k:v for k,v in payload.items() if k!='files'}
    manifest.update(createdAt=datetime.now(timezone.utc).isoformat(), status='incomplete', files=records, image=image)
    write_manifest(dest, manifest)
    if args.include_image:
        image_id=payload['imageId']
        if not re.fullmatch(r'sha256:[0-9a-f]{64}',image_id): raise ValueError('Invalid immutable image ID')
        target=dest/'image.tar'
        with target.open('xb') as f:
            result=subprocess.run(ssh+['docker','image','save',image_id],stdout=f,stderr=subprocess.PIPE,timeout=args.image_timeout_seconds)
            f.flush();os.fsync(f.fileno())
        if result.returncode: raise RuntimeError('Image streaming failed; incomplete operation must not be used')
        identity=verify_image_archive(target,image_id)
        with target.open('rb') as f: sha=hashlib.file_digest(f,'sha256').hexdigest()
        image={'included':True,'path':'image.tar','sha256':sha,'bytes':target.stat().st_size,'imageId':image_id,'identity':identity,'restorationVerified':False}
    manifest.update(status='complete',files=records,image=image,
        consistency='Idle observed before/after; two matching data snapshots and same container/image/start. Not a filesystem freeze.',
        excludes=['host operating system','other services','provider account configuration','external provider records'],
        recovery='Complete server-loss recovery additionally requires image archive, host setup and provider connectivity. No restoration claimed by backup alone.')
    write_manifest(dest, manifest)
    (dest/'RECOVERY.txt').write_text('PRIVATE BACKUP. Do not publish or upload. Verify all manifest hashes before use. Run pilot-restore-check.py for an offline file/SQLite restoration rehearsal. It does not certify live telephony restoration. Image archive is present only when manifest.image.included=true. Production recovery requires an explicit operator action, compatible Docker host, restored private data and runtime.env, matching immutable image, network/ports reviewed from private/container-inspect.json, and a separately authorized call. Never start two instances with live credentials or duplicate SIP registrations. Restore with realCallsEnabled=false until independently authorized. Preserve previous release and copies. No remote backup files were created.\n',encoding='utf-8')
    print(json.dumps({'status':'verified_local_files','path':str(dest),'files':len(records),'imageIncluded':image['included'],'fullRestorationTested':False}))

if __name__=='__main__':
    try: main()
    except Exception as exc:
        print('Backup failed: '+type(exc).__name__+'. Private contents suppressed.',file=sys.stderr)
        sys.exit(1)
