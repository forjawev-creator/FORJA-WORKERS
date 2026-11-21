"""Offline Docker/OCI image identity and rootfs verifier. No extraction or network."""
import gzip
import hashlib
import json
import os
import re
import tarfile


def verify_image_archive(path, image_id):
    """Validate a legacy config ID or a cryptographically anchored OCI graph.

    index.json is only a locator. Trust comes from the expected immutable digest,
    then every size/digest edge to the selected platform/config/layers, including
    additional referenced attestation blobs. Nothing is fetched from descriptor URLs.
    """
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise ValueError('invalid_image_identity')
    with path.open('rb') as raw:
        raw.seek(-1024, os.SEEK_END)
        if raw.read() != b'\0' * 1024:
            raise ValueError('missing_tar_end_blocks')
    with tarfile.open(path, 'r:') as archive:
        files = {}
        for member in archive.getmembers():
            if member.isdir(): continue
            if member.name in files: raise ValueError('duplicate_archive_member')
            files[member.name] = member
        def member(name):
            if not isinstance(name,str) or name.startswith('/') or '..' in name.split('/') or '\\' in name:
                raise ValueError('unsafe_archive_member')
            value = files.get(name)
            if value is None or not value.isfile(): raise ValueError('missing_regular_blob')
            return value
        def json_member(name):
            info = member(name)
            if info.size > 4 * 1024 * 1024: raise ValueError('oversized_image_metadata')
            with archive.extractfile(info) as stream: return json.load(stream)
        entries = json_member('manifest.json')
        if not isinstance(entries,list) or len(entries) != 1:
            raise ValueError('unexpected_image_count')
        item = entries[0]
        if not isinstance(item.get('Config'),str) or not isinstance(item.get('Layers'),list):
            raise ValueError('invalid_docker_manifest')
        config = json_member(item['Config'])
        with archive.extractfile(member(item['Config'])) as stream:
            config_digest = 'sha256:' + hashlib.file_digest(stream,'sha256').hexdigest()
        expected_layers = config['rootfs']['diff_ids']
        if not isinstance(expected_layers,list) or len(expected_layers) != len(item['Layers']) or any(not re.fullmatch(r'sha256:[0-9a-f]{64}',v) for v in expected_layers):
            raise ValueError('layer_count_or_identity_mismatch')
        indexes = {'application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json'}
        manifests = {'application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json'}
        verified = {}
        visiting = set()
        reachable_images = []
        def blob(descriptor):
            digest=descriptor.get('digest');size=descriptor.get('size')
            if not isinstance(digest,str) or not re.fullmatch(r'sha256:[0-9a-f]{64}',digest) or type(size) is not int or size < 0:
                raise ValueError('invalid_oci_descriptor')
            name='blobs/'+digest.replace(':','/')
            info=member(name)
            if info.size != size: raise ValueError('oci_blob_size_mismatch')
            if digest not in verified:
                with archive.extractfile(info) as stream:
                    actual='sha256:'+hashlib.file_digest(stream,'sha256').hexdigest()
                if actual != digest: raise ValueError('oci_blob_digest_mismatch')
                verified[digest]=size
            elif verified[digest] != size: raise ValueError('conflicting_oci_descriptor')
            return name
        def walk(descriptor,depth=0):
            if depth > 16: raise ValueError('oci_graph_too_deep')
            name=blob(descriptor);digest=descriptor['digest'];media=descriptor.get('mediaType')
            if media not in indexes | manifests: raise ValueError('unsupported_oci_manifest_type')
            if digest in visiting: raise ValueError('oci_graph_cycle')
            visiting.add(digest)
            document=json_member(name)
            if document.get('schemaVersion')!=2 or document.get('mediaType')!=media:
                raise ValueError('oci_manifest_schema_mismatch')
            if media in indexes:
                children=document.get('manifests')
                if not isinstance(children,list) or not 1 <= len(children) <= 128: raise ValueError('invalid_oci_index')
                for child in children: walk(child,depth+1)
            else:
                configuration=document.get('config');layers=document.get('layers')
                if not isinstance(configuration,dict) or not isinstance(layers,list) or len(layers)>2048:
                    raise ValueError('invalid_oci_image_manifest')
                blob(configuration)
                for layer in layers: blob(layer)
                reachable_images.append((descriptor,document))
            if document.get('subject') is not None: walk(document['subject'],depth+1)
            reference=descriptor.get('annotations',{}).get('vnd.docker.reference.digest')
            if reference is not None:
                if not isinstance(reference,str) or not re.fullmatch(r'sha256:[0-9a-f]{64}',reference): raise ValueError('invalid_attestation_reference')
                target=member('blobs/'+reference.replace(':','/'))
                blob({'digest':reference,'size':target.size})
            visiting.remove(digest)
        identity_kind='config'
        platform={'os':config.get('os'),'architecture':config.get('architecture')}
        selected_manifest=None
        if config_digest != image_id:
            layout=json_member('index.json')
            if layout.get('schemaVersion')!=2 or not isinstance(layout.get('manifests'),list): raise ValueError('invalid_oci_layout_index')
            roots=[d for d in layout['manifests'] if d.get('digest')==image_id]
            if len(roots)!=1: raise ValueError('image_identity_not_in_oci_index')
            walk(roots[0])
            matches={}
            for descriptor,document in reachable_images:
                if document['config']['digest']!=config_digest: continue
                declared=descriptor.get('platform')
                if declared is not None and (declared.get('os')!=config.get('os') or declared.get('architecture')!=config.get('architecture') or (declared.get('variant') is not None and declared['variant']!=config.get('variant'))):
                    raise ValueError('oci_platform_config_mismatch')
                # The same immutable image may be referenced again as an attestation subject.
                if descriptor['digest'] not in matches or declared is not None:
                    matches[descriptor['digest']]=(descriptor,document)
            if len(matches)!=1: raise ValueError('docker_config_not_uniquely_reachable')
            selected,document=next(iter(matches.values()))
            if item['Config']!='blobs/'+config_digest.replace(':','/'):
                raise ValueError('docker_config_path_not_linked')
            linked_layers=['blobs/'+layer['digest'].replace(':','/') for layer in document['layers']]
            if linked_layers!=item['Layers']: raise ValueError('docker_layers_not_linked')
            platform=selected.get('platform',platform)
            if platform.get('os')!=config.get('os') or platform.get('architecture')!=config.get('architecture') or (platform.get('variant') is not None and platform['variant']!=config.get('variant')):
                raise ValueError('oci_platform_config_mismatch')
            identity_kind='oci_index' if roots[0]['mediaType'] in indexes else 'oci_manifest'
            selected_manifest=selected['digest']
        for name,expected in zip(item['Layers'],expected_layers):
            with archive.extractfile(member(name)) as layer:
                magic=layer.read(4);layer.seek(0)
                if magic==b'\x28\xb5\x2f\xfd': raise ValueError('zstd_layer_not_supported')
                source=gzip.GzipFile(fileobj=layer) if magic[:2]==b'\x1f\x8b' else layer
                sha=hashlib.sha256()
                while chunk:=source.read(1024*1024): sha.update(chunk)
                if 'sha256:'+sha.hexdigest()!=expected: raise ValueError('layer_digest_mismatch')
        return {'sourceImageId':image_id,'identityKind':identity_kind,'configDigest':config_digest,
                'platformManifestDigest':selected_manifest,'os':config.get('os'),'architecture':config.get('architecture'),
                'diffIds':expected_layers,'referencedBlobsVerified':len(verified)}
