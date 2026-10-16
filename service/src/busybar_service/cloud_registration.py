"""Computer enrollment. Persist credentials in Keychain before any server grant."""
import json
import fcntl
from functools import wraps
import os
from pathlib import Path
import re
import secrets
import uuid

from busybar_shared.cloud import CloudError, IDENTIFIER, Transport, atomic_json, base_url, keychain

FILE = 'cloud-computer.json'
HEX = re.compile(r'^[a-f0-9]{64}$')
SECRET = re.compile(r'^[A-Za-z0-9_-]{40,64}$')


def _serialized(work):
    @wraps(work)
    def call(runtime, *args, **kwargs):
        root = Path(runtime)
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if root.stat().st_mode & 0o077:
            raise CloudError('runtime_permissions')
        descriptor = os.open(root / 'cloud-registration.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'r+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise CloudError('registration_busy') from None
            return work(runtime, *args, **kwargs)
    return call


def valid_id(value):
    return isinstance(value, str) and bool(IDENTIFIER.fullmatch(value)) and value not in ('__proto__', 'constructor', 'prototype')


def load_computer(runtime):
    try:
        path = Path(runtime) / FILE
        if not path.exists():
            raise CloudError('setup_required_computer')
        with path.open('rb') as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) - {'version', 'url', 'deviceId', 'computerId', 'instanceId', 'phase', 'services', 'routes'}:
            raise ValueError()
        base_url(value['url'])
        if not HEX.fullmatch(value['deviceId']) or not all(valid_id(value[k]) for k in ('computerId', 'instanceId')):
            raise ValueError()
        if value['phase'] not in ('pending', 'active'):
            raise ValueError()
        entries, routes = value['services'], value['routes']
        if not isinstance(entries, dict) or len(entries) > 32 or not isinstance(routes, dict) or len(routes) > 128:
            raise ValueError()
        ids = set()
        for alias, entry in entries.items():
            if not valid_id(alias) or not isinstance(entry, dict) or not valid_id(entry.get('serviceId')):
                raise ValueError()
            if entry['serviceId'] in ids or entry.get('template') not in ('agent', 'notifier', 'custom'):
                raise ValueError()
            ids.add(entry['serviceId'])
            if not entry.get('pending') and (not isinstance(entry.get('epoch'), str) or not 1 <= len(entry['epoch']) <= 256):
                raise ValueError()
            if set(entry) - {'serviceId', 'template', 'name', 'epoch', 'epochExpiresAt', 'pending', 'fallbackSeconds'}:
                raise ValueError()
        if any(not valid_id(source) or service_id not in ids for source, service_id in routes.items()):
            raise ValueError()
        return value
    except CloudError:
        raise
    except (OSError, ValueError, KeyError, TypeError, UnicodeError, RecursionError):
        raise CloudError('invalid_computer_config') from None


def _saved_credential(config, store):
    credential = store('computer')
    prefix = config['deviceId'] + '.c.' + config['computerId'] + '.'
    if not isinstance(credential, str) or not credential.startswith(prefix) or not SECRET.fullmatch(credential[len(prefix):]):
        raise CloudError('invalid_computer_credential')
    return credential


def _verify(config, credential, transport):
    value = transport(config['url'], credential).request('GET', '/api/computer')
    if value.get('computerId') != config['computerId'] or value.get('deviceId') != config['deviceId']:
        raise CloudError('computer_identity_mismatch')
    return value


@_serialized
def enroll(runtime, url, ticket, *, store=keychain, transport=Transport, secret_factory=None):
    url = base_url(url)
    match = re.fullmatch(r'enroll\.([a-f0-9]{64})\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{40,64})', ticket)
    if not match or not valid_id(match[2]):
        raise CloudError('invalid_enrollment')
    device, computer = match[1], match[2]
    try:
        config = load_computer(runtime)
    except CloudError as error:
        if error.code != 'setup_required_computer':
            raise
        config = None
    if config:
        if (config['url'], config['deviceId'], config['computerId']) != (url, device, computer):
            raise CloudError('computer_already_configured')
        credential = _saved_credential(config, store)
        try:
            _verify(config, credential, transport)
        except CloudError as error:
            if error.status != 404 or config['phase'] != 'pending':
                raise
        else:
            config['phase'] = 'active'
            atomic_json(Path(runtime) / FILE, config)
            return config
        secret = credential.rsplit('.', 1)[1]
    else:
        secret = (secret_factory or (lambda: secrets.token_urlsafe(32)))()
        if not isinstance(secret, str) or not SECRET.fullmatch(secret):
            raise CloudError('invalid_computer_credential')
        credential = device + '.c.' + computer + '.' + secret
        # No server request is made unless both private stores succeed.
        store('computer', credential)
        config = {'version': 1, 'url': url, 'deviceId': device, 'computerId': computer,
                  'instanceId': 'mac-' + uuid.uuid4().hex[:16], 'phase': 'pending', 'services': {}, 'routes': {}}
        atomic_json(Path(runtime) / FILE, config)
    result = transport(url, ticket).request('POST', '/api/computers/enroll', {'managementSecret': secret})
    if result.get('computerId') != computer:
        raise CloudError('computer_identity_mismatch')
    _verify(config, credential, transport)
    config['phase'] = 'active'
    atomic_json(Path(runtime) / FILE, config)
    return config


@_serialized
def register_service(runtime, alias, *, name=None, template='notifier', source=None,
                     store=keychain, transport=Transport, id_factory=None):
    """Register a named local route, retaining its intended ID across lost replies."""
    if not valid_id(alias) or not valid_id(source or alias) or template not in ('agent', 'notifier', 'custom'):
        raise CloudError('invalid_service')
    name = name or alias.title()
    if not isinstance(name, str) or not 1 <= len(name) <= 80:
        raise CloudError('invalid_service')
    config = load_computer(runtime)
    if config['phase'] != 'active':
        raise CloudError('computer_enrollment_pending')
    credential = _saved_credential(config, store)
    remote = _verify(config, credential, transport)
    entry = config['services'].get(alias)
    if entry is None:
        if len(config['services']) >= 32:
            raise CloudError('service_capacity')
        ident = (id_factory or (lambda: str(uuid.uuid4())))()
        if not valid_id(ident) or any(s['serviceId'] == ident for s in config['services'].values()):
            raise CloudError('invalid_service')
        entry = {'serviceId': ident, 'template': template, 'name': name, 'pending': True}
        config['services'][alias] = entry
        atomic_json(Path(runtime) / FILE, config)
    elif entry['template'] != template:
        raise CloudError('registration_template_mismatch')
    ident = entry['serviceId']
    known = next((s for s in remote.get('services', []) if s.get('id') == ident), None)
    if known is None:
        if not entry.get('pending'):
            raise CloudError('service_registration_missing')
        try:
            transport(config['url'], credential).request('POST', '/api/services', {
                'id': ident, 'name': entry['name'], 'template': entry['template'],
                'expectedRevision': remote['configRevision'], 'computerId': config['computerId'],
            })
        except CloudError:
            # A lost response may have committed. Read once; never invent success.
            remote = _verify(config, credential, transport)
            known = next((s for s in remote.get('services', []) if s.get('id') == ident), None)
            if known is None:
                raise
        else:
            remote = _verify(config, credential, transport)
            known = next((s for s in remote.get('services', []) if s.get('id') == ident), None)
    if (not known or known.get('computerId') != config['computerId'] or known.get('template') != entry['template']
            or not isinstance(known.get('epoch'), str) or not known['epoch']):
        raise CloudError('registration_identity_mismatch')
    if not entry.get('pending') and entry.get('epoch') != known['epoch']:
        raise CloudError('registration_epoch_changed')
    entry.update(epoch=known['epoch'], epochExpiresAt=known.get('epochExpiresAt'), pending=False)
    config['routes'][source or alias] = ident
    atomic_json(Path(runtime) / FILE, config)
    return config


@_serialized
def migrate_legacy(runtime, url, *, store=keychain, transport=Transport, secret_factory=None):
    """Claim only the installation proved by all of its existing role credentials."""
    from busybar_shared.cloud import load_config
    url = base_url(url)
    try:
        config = load_computer(runtime)
    except CloudError as error:
        if error.code != 'setup_required_computer':
            raise
        config = None
    if config:
        if config['url'] != url:
            raise CloudError('computer_already_configured')
        credential = _saved_credential(config, store)
        try:
            _verify(config, credential, transport)
        except CloudError as error:
            if error.status != 404 or config['phase'] != 'pending':
                raise
        else:
            config['phase'] = 'active'
            atomic_json(Path(runtime) / FILE, config)
            return config
    proofs, identities, instances = {}, set(), []
    for role in ('agent', 'notifier'):
        if not (Path(runtime) / ('cloud-' + role + '.json')).exists():
            continue
        legacy = load_config(runtime, role)
        proof = store(role)
        match = re.fullmatch(r'([a-f0-9]{64})\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{40,64})', proof)
        if not match or match[2] != legacy['serviceId']:
            raise CloudError('legacy_credential_mismatch')
        view = transport(url, proof).request('GET', '/api/snapshot')
        services = view.get('services', [])
        if view.get('protocol') != 1 or view.get('deviceId') != match[1] or len(services) != 1:
            raise CloudError('legacy_credential_mismatch')
        service = services[0]
        if service.get('id') != legacy['serviceId'] or not valid_id(service.get('computerId')):
            raise CloudError('legacy_credential_mismatch')
        proofs[service['id']] = proof
        identities.add((match[1], service['computerId']))
        instances.append(legacy['instanceId'])
    if not proofs or len(identities) != 1:
        raise CloudError('legacy_computer_mismatch')
    device, computer = next(iter(identities))
    if config:
        if (config['deviceId'], config['computerId']) != (device, computer):
            raise CloudError('computer_already_configured')
        secret = credential.rsplit('.', 1)[1]
    else:
        secret = (secret_factory or (lambda: secrets.token_urlsafe(32)))()
        if not isinstance(secret, str) or not SECRET.fullmatch(secret):
            raise CloudError('invalid_computer_credential')
        credential = device + '.c.' + computer + '.' + secret
        store('computer', credential)
        config = {'version': 1, 'url': url, 'deviceId': device, 'computerId': computer, 'instanceId': instances[0],
                  'phase': 'pending', 'services': {}, 'routes': {}}
        atomic_json(Path(runtime) / FILE, config)
    result = transport(url, next(iter(proofs.values()))).request('POST', '/api/computers/claim',
                                                               {'proofs': proofs, 'managementSecret': secret})
    if result.get('computerId') != computer:
        raise CloudError('computer_identity_mismatch')
    _verify(config, credential, transport)
    config['phase'] = 'active'
    atomic_json(Path(runtime) / FILE, config)
    return config


@_serialized
def pairing_code(runtime, *, store=keychain, transport=Transport):
    config = load_computer(runtime)
    if config['phase'] != 'active':
        raise CloudError('computer_enrollment_pending')
    credential = _saved_credential(config, store)
    _verify(config, credential, transport)
    result = transport(config['url'], credential).request('POST', '/api/computers/pairing', {})
    code = result.get('code')
    if not isinstance(code, str) or not re.fullmatch(r'pair\.' + re.escape(config['deviceId']) + r'\.[A-Za-z0-9_-]{40,64}', code):
        raise CloudError('invalid_pairing_response')
    return code
