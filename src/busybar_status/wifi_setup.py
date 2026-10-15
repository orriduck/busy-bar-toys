"""Configure local button input without changing device access settings."""
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import tempfile

from .credentials import InputTokenMissing, read_input_token, store_input_token


class WifiSetupError(RuntimeError):
    pass


def _wifi_address(status):
    # Firmware 1.2.4 StatusResponse: state + ip_config.address, not a top-level IP.
    if not isinstance(status,dict) or status.get('state')!='connected':
        raise ValueError('Wi-Fi is not connected')
    config=status.get('ip_config')
    address=config.get('address') if isinstance(config,dict) else None
    if not isinstance(address,str):
        raise ValueError('Wi-Fi address is unavailable')
    address=ipaddress.ip_address(address)
    if (not address.is_private or address.is_unspecified
            or address.is_loopback or address.is_multicast):
        raise ValueError('Wi-Fi requires a private network address')
    return f'[{address}]' if address.version==6 else str(address)


def _save_config(runtime, config):
    runtime=Path(runtime)
    runtime.mkdir(mode=0o700,parents=True,exist_ok=True)
    runtime.chmod(0o700)
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(mode='w',dir=runtime,delete=False) as stream:
            temporary=Path(stream.name)
            os.fchmod(stream.fileno(),0o600)
            json.dump(config,stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(runtime/'input.json')
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def configure_wifi(client, runtime):
    """Return non-secret configuration; create a token only for a missing item."""
    created_id=None
    verified_new_token=False
    try:
        config={'addr':_wifi_address(client.request('/wifi/status'))}
        try:
            read_input_token()
        except InputTokenMissing:
            created=client.request('/access/tokens','POST',{'name':'Codex status input'})
            short_id=created.get('short_id') if isinstance(created,dict) else None
            if not isinstance(short_id,str) or not re.fullmatch(r'[A-Za-z0-9]{8}',short_id):
                raise ValueError('Invalid token cleanup identifier')
            created_id=short_id
            token=created.get('token')
            if (not isinstance(token,str) or not token or not token.isascii()
                    or any(character.isspace() for character in token)):
                raise ValueError('Invalid local input token')
            store_input_token(token)
            if not hmac.compare_digest(read_input_token(),token):
                raise ValueError('Keychain readback did not match')
            verified_new_token=True
        _save_config(runtime,config)
        return config
    except Exception:
        if created_id is not None and not verified_new_token:
            try:
                client.request('/access/tokens/'+created_id,'DELETE')
            except Exception:
                raise WifiSetupError('Wi-Fi input setup failed; new token cleanup could not be confirmed.') from None
        if verified_new_token:
            # Preserve a confirmed Keychain item for a later setup attempt.
            raise WifiSetupError('Local input credentials are stored, but Wi-Fi configuration could not be saved.') from None
        raise WifiSetupError('Could not configure Wi-Fi button input.') from None
