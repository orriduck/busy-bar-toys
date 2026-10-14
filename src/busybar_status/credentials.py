"""Read credentials from the macOS Keychain, never from repo files or argv."""
import subprocess
from .api import AuthError

SERVICE = "app.busybar.ai-status"
ACCOUNT = "busy-bar"


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
