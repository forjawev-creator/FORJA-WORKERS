"""Synthetic OCI graphs, attestations and legacy images; never Docker/network."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('image_verifier',Path(__file__).with_name('image-archive-verifier.py'))
verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)

def oci_fixture():
    files={}
    def encoded(value): return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
    def blob(data,media):
        digest='sha256:'+hashlib.sha256(data).hexdigest();files['blobs/'+digest.replace(':','/')]=data
        return {'mediaType':media,'digest':digest,'size':len(data)}
    raw_layers=[b'synthetic OCI layer one',b'synthetic OCI layer two']
    layers=[blob(gzip.compress(raw_layers[0],mtime=0),'application/vnd.oci.image.layer.v1.tar+gzip'),blob(raw_layers[1],'application/vnd.oci.image.layer.v1.tar')]
    config=blob(encoded({'os':'linux','architecture':'amd64','rootfs':{'type':'layers','diff_ids':['sha256:'+hashlib.sha256(data).hexdigest() for data in raw_layers]}}),'application/vnd.oci.image.config.v1+json')
    manifest=blob(encoded({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':config,'layers':layers}),'application/vnd.oci.image.manifest.v1+json')
    manifest['platform']={'os':'linux','architecture':'amd64'}
    att_config=blob(b'{}','application/vnd.oci.image.config.v1+json')
    att_layer=blob(b'{"syntheticAttestation":true}','application/vnd.in-toto+json')
    att=blob(encoded({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':att_config,'layers':[att_layer],'subject':{k:manifest[k] for k in ['mediaType','digest','size']}}),'application/vnd.oci.image.manifest.v1+json')
    att['platform']={'os':'unknown','architecture':'unknown'};att['annotations']={'vnd.docker.reference.digest':manifest['digest']}
    root=blob(encoded({'schemaVersion':2,'mediaType':'application/vnd.oci.image.index.v1+json','manifests':[manifest,att]}),'application/vnd.oci.image.index.v1+json')
    files['index.json']=encoded({'schemaVersion':2,'manifests':[root]})
    files['manifest.json']=encoded([{'Config':'blobs/'+config['digest'].replace(':','/'),'Layers':['blobs/'+d['digest'].replace(':','/') for d in layers],'RepoTags':None}])
    return files,root,config,layers,att_layer


def write_tar(path,files):
    with tarfile.open(path,'w') as tar:
        for name,data in files.items():
            info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))


class ImageIdentity(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='forja-image-identity-')
        self.destination=Path(self.temp.name).resolve()
    def tearDown(self):
        assert self.destination.name.startswith('forja-image-identity-')
        self.temp.cleanup()
    def test_oci_index_validates_graph_attestation_and_uncompressed_diff_ids(self):
        files,root,config,layers,att=oci_fixture();p=self.destination/'oci.tar';write_tar(p,files)
        verified=verifier.verify_image_archive(p,root['digest'])
        self.assertEqual(verified['identityKind'],'oci_index');self.assertEqual(verified['configDigest'],config['digest'])
        self.assertEqual(verified['os'],'linux');self.assertEqual(verified['architecture'],'amd64')
        self.assertEqual(verified['referencedBlobsVerified'],8)

    def test_oci_root_config_layer_and_attestation_tampering_are_rejected(self):
        for kind in ['root','config','layer','attestation']:
            files,root,config,layers,att=oci_fixture()
            descriptor={'root':root,'config':config,'layer':layers[0],'attestation':att}[kind]
            name='blobs/'+descriptor['digest'].replace(':','/');files[name]=files[name].replace(b'amd64',b'arm64') if kind=='config' else b'X'+files[name][1:]
            p=self.destination/(kind+'.tar');write_tar(p,files)
            with self.assertRaisesRegex(ValueError,'oci_blob_digest_mismatch'):verifier.verify_image_archive(p,root['digest'])

    def test_oci_unlinked_config_or_reordered_layers_are_rejected(self):
        for kind in ['config','layers']:
            files,root,config,layers,att=oci_fixture();manifest=json.loads(files['manifest.json'])
            if kind=='config':
                data=json.loads(files[manifest[0]['Config']]);data['syntheticExtra']='not anchored'
                encoded=json.dumps(data).encode();name='blobs/sha256/'+hashlib.sha256(encoded).hexdigest()
                files[name]=encoded;manifest[0]['Config']=name
            else:manifest[0]['Layers'].reverse()
            files['manifest.json']=json.dumps(manifest).encode();p=self.destination/(kind+'-unlinked.tar');write_tar(p,files)
            with self.assertRaisesRegex(ValueError,'not_uniquely_reachable|not_linked'):verifier.verify_image_archive(p,root['digest'])

    def test_oci_descriptor_size_and_missing_attestation_rejected(self):
        files,root,config,layers,att=oci_fixture();layout=json.loads(files['index.json']);layout['manifests'][0]['size']+=1
        files['index.json']=json.dumps(layout).encode();p=self.destination/'size.tar';write_tar(p,files)
        with self.assertRaisesRegex(ValueError,'size_mismatch'):verifier.verify_image_archive(p,root['digest'])
        files,root,config,layers,att=oci_fixture();del files['blobs/'+att['digest'].replace(':','/')];write_tar(p,files)
        with self.assertRaisesRegex(ValueError,'missing_regular_blob'):verifier.verify_image_archive(p,root['digest'])


if __name__=='__main__':unittest.main()
