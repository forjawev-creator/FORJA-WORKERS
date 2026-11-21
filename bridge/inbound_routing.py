"""Pure, fail-closed initial SIP routing contract. Not wired into the live bridge.

Policies/bindings are backend-provisioned records, never values supplied by callers.
peer_ip/peer_port/listener_id must come from the receiving socket, never headers.
IP allowlisting is a network boundary, not cryptographic caller authentication.
"""
from dataclasses import dataclass
import hashlib
import ipaddress
import re
from uuid import UUID


class RoutingRejected(ValueError):
    """Public error contains only a category, never phone numbers or SIP content."""


def canonical_number(value):
    if not isinstance(value, str) or not re.fullmatch(r'\+?[1-9][0-9]{7,14}', value):
        raise RoutingRejected('invalid_destination')
    return '+' + value.lstrip('+')


@dataclass(frozen=True)
class VerifiedBinding:
    destination: str
    installation_id: str
    verification_id: str = ''
    verified_until: int = 0
    active: bool = False

    def __post_init__(self):
        object.__setattr__(self, 'destination', canonical_number(self.destination))
        try:
            installation = UUID(self.installation_id)
        except (ValueError, TypeError, AttributeError):
            raise RoutingRejected('invalid_installation') from None
        if installation.int == 0:
            raise RoutingRejected('invalid_installation')
        object.__setattr__(self, 'installation_id', str(installation))


@dataclass(frozen=True)
class InboundPolicy:
    listener_id: str
    provider_profile_id: str
    # Exact socket peers, populated only after provider/account verification.
    allowed_peers: tuple[tuple[str, int], ...] = ()
    request_uri_hosts: tuple[str, ...] = ()
    bindings: tuple[VerifiedBinding, ...] = ()
    network_verification_id: str = ''
    network_verified_until: int = 0
    enabled: bool = False

    def __post_init__(self):
        normalized = tuple((str(ipaddress.ip_address(ip)), port) for ip, port in self.allowed_peers)
        if any(not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535 for _, port in normalized):
            raise RoutingRejected('invalid_peer_configuration')
        object.__setattr__(self, 'allowed_peers', normalized)
        if len({b.destination for b in self.bindings}) != len(self.bindings):
            raise RoutingRejected('ambiguous_destination_mapping')
        if any(not re.fullmatch(r'[A-Za-z0-9.-]+(?::[0-9]{1,5})?', host) for host in self.request_uri_hosts):
            raise RoutingRejected('invalid_destination_host')


@dataclass(frozen=True)
class ResolvedInbound:
    installation_id: str
    destination: str
    provider_profile_id: str
    verification_id: str
    dialog_key: str
    caller_authenticated: bool = False
    trust_scope: str = 'routing_only'


def resolve_inbound(message, *, peer_ip, peer_port, listener_id, policy, now):
    """Validate a fresh INVITE's destination; does not answer, reserve or run tools.

The controller must deduplicate dialog_key, validate installation/module/plan,
reserve budget/capacity atomically, and apply external-caller tool permissions.
Unknown syntax is rejected rather than falling back to To/From/Diversion/X-*.
"""
    if policy.enabled is not True:
        raise RoutingRejected('inbound_disabled')
    if (not policy.network_verification_id or now >= policy.network_verified_until
            or listener_id != policy.listener_id):
        raise RoutingRejected('unverified_ingress')
    try:
        peer = (str(ipaddress.ip_address(peer_ip)), peer_port)
    except ValueError:
        raise RoutingRejected('untrusted_peer') from None
    if peer not in policy.allowed_peers:
        raise RoutingRejected('untrusted_peer')
    if not isinstance(message, str) or len(message.encode('utf-8')) > 65536 or '\x00' in message:
        raise RoutingRejected('invalid_sip_message')
    header, separator, _body = message.partition('\r\n\r\n')
    if not separator or '\n' in header.replace('\r\n', '') or '\r' in header.replace('\r\n', ''):
        raise RoutingRejected('invalid_sip_message')
    lines = header.split('\r\n')
    match = re.fullmatch(r'INVITE sip:(\+?[1-9][0-9]{7,14})@([A-Za-z0-9.-]+(?::[0-9]{1,5})?)(?:;user=phone)? SIP/2\.0', lines[0])
    if not match:
        raise RoutingRejected('unsupported_request_uri')
    if match.group(2).lower() not in {host.lower() for host in policy.request_uri_hosts}:
        raise RoutingRejected('unverified_destination_host')
    destination = canonical_number(match.group(1))
    fields = {}
    for line in lines[1:]:
        if line.startswith((' ', '\t')) or ':' not in line:
            raise RoutingRejected('invalid_sip_header')
        name, value = line.split(':', 1)
        name = name.lower()
        if not re.fullmatch(r'[a-z0-9!#$%&\x27*+.^_`|~-]+', name):
            raise RoutingRejected('invalid_sip_header')
        name = {'i': 'call-id'}.get(name, name)
        if name in ('call-id', 'cseq') and name in fields:
            raise RoutingRejected('ambiguous_sip_transaction')
        fields[name] = value.strip()
    call_id = fields.get('call-id', '')
    if not re.fullmatch(r'[A-Za-z0-9_.@+!-]{1,160}', call_id):
        raise RoutingRejected('invalid_call_id')
    if not re.fullmatch(r'[1-9][0-9]{0,9} INVITE', fields.get('cseq', '')):
        raise RoutingRejected('invalid_invite_sequence')
    binding = next((b for b in policy.bindings if b.destination == destination), None)
    if binding is None:
        raise RoutingRejected('unknown_destination')
    if binding.active is not True or not binding.verification_id or now >= binding.verified_until:
        raise RoutingRejected('inactive_or_unverified_destination')
    # Retransmissions map to the same key. It is not a credential or an authorization.
    material = '\0'.join([policy.provider_profile_id, binding.installation_id, destination, call_id])
    return ResolvedInbound(binding.installation_id, destination, policy.provider_profile_id,
        binding.verification_id, hashlib.sha256(material.encode()).hexdigest())
