"""Read credentials from the macOS Keychain, never from repo files or argv."""
import subprocess
from pathlib import Path
from .api import AuthError

SERVICE = "app.busybar.ai-status"
ACCOUNT = "busy-bar"
INPUT_HELPER = Path(__file__).resolve().parents[2] / ".venv/bin/busy-input-keychain"


class InputTokenMissing(AuthError):
    """Only the dedicated local-input Keychain item is absent."""


def read_token():
    try:
        result = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", SERVICE,
                                 "-a", ACCOUNT, "-w"], capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        raise AuthError("Keychain permission is pending; approve it and restart the observer.") from None
    if result.returncode:
        raise AuthError("BUSY token is unavailable in Keychain; unlock it or run token-set.")
    token = result.stdout.strip()
    if not token:
        raise AuthError("The Keychain token is empty.")
    return token


def read_input_token():
    try:
        result = subprocess.run([str(INPUT_HELPER), "get"], capture_output=True,
                                text=True, timeout=5)
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise AuthError("Local BUSY input token is unavailable in Keychain.") from None
    if result.returncode == 2:
        raise InputTokenMissing("Local BUSY input token has not been stored.")
    if result.returncode:
        raise AuthError("Local BUSY input Keychain access was denied or locked.")
    token = result.stdout.strip()
    if not token or any(c.isspace() for c in token):
        raise AuthError("Local BUSY input Keychain token is invalid.")
    return token


def store_input_token(token):
    if not isinstance(token, str) or not token or any(c.isspace() for c in token):
        raise AuthError("A valid local BUSY input token is required.")
    try:
        result = subprocess.run([str(INPUT_HELPER), "set"], input=token,
                                capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise AuthError("Local BUSY input token could not be stored in Keychain.") from None
    if result.returncode:
        raise AuthError("Local BUSY input token could not be stored in Keychain.")
