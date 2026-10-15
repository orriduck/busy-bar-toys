"""Read explicit Your dot (Orbit) thread identities from local Codex state."""
import json
from pathlib import Path


def load_dot_thread_ids(state_path: Path) -> set[str]:
    """Read only explicit Orbit identity metadata, never cached task status."""
    try:
        state = json.loads(Path(state_path).read_text())
    except (OSError, ValueError, UnicodeDecodeError):
        return set()
    if not isinstance(state, dict):
        return set()
    atoms = state.get("electron-persisted-atom-state", {})
    if not isinstance(atoms, dict):
        return set()
    ids = set()
    selected = atoms.get("primary-aeon-selection-v1", {})
    response = selected.get("response", {}) if isinstance(selected, dict) else {}
    profile = response.get("profile", {}) if isinstance(response, dict) else {}
    selection = response.get("selection", {}) if isinstance(response, dict) else {}
    if isinstance(profile, dict) and profile.get("aeon_kind") == "orbit" and isinstance(selection, dict):
        thread = selection.get("thread_id")
        if isinstance(thread, str) and thread:
            ids.add(thread)
    cache = atoms.get("cloud-aeon-sidebar-cache-v1", {})
    profiles = cache.get("profilesByThreadId", {}) if isinstance(cache, dict) else {}
    if isinstance(profiles, dict):
        for thread, profile in profiles.items():
            if isinstance(profile, dict) and profile.get("aeon_kind") == "orbit":
                if isinstance(thread, str) and thread:
                    ids.add(thread)
                root = profile.get("active_root_thread_id")
                if isinstance(root, str) and root:
                    ids.add(root)
    return ids
