"""Private metadata-only event spool, usable by hooks or a Dots local tool."""
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import time

from . import profiles

RUNTIME = Path.home() / "Library/Application Support/BusyBarAI"
SPOOL = RUNTIME / "events"


def hook_event(payload, *, now=None, source="chatgpt", previous_turn=None):
    if not isinstance(payload, dict) or not payload.get("session_id"):
        return None
    event = payload.get("hook_event_name")
    if not isinstance(event, str): return None
    agent = profiles.profile(source)
    state = agent.hook_states.get(event)
    if callable(state): state = state(payload)
    if event == "PreToolUse" and str(payload.get("tool_name", "")).split(".")[-1] in agent.waiting_tools:
        state = "waiting"
    if state is None: return None
    now = time.time() if now is None else now
    turn = str(payload.get("turn_id", ""))[:200]
    if not turn and agent.new_turn_events:
        # Hooks without turn identifiers: a new prompt starts a new local turn.
        turn = f"local-{int(now * 1000)}" if event in agent.new_turn_events else (previous_turn or "")
    return {"session_id": str(payload["session_id"])[:200],
            "turn_id": turn[:200],
            "state": state, "source": source,
            "cwd": Path(str(payload.get("cwd", ""))).name,
            "timestamp": now}


def _event_path(root, session):
    return Path(root) / (hashlib.sha256(str(session).encode()).hexdigest() + ".json")


def read_event(root, session):
    try:
        event = json.loads(_event_path(root, session).read_text())
        return event if isinstance(event, dict) else None
    except (OSError, ValueError):
        return None


def write_event(root, event):
    root = Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    fd, temporary = tempfile.mkstemp(prefix=".event-", dir=root)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(event, handle, ensure_ascii=True)
        os.replace(temporary, _event_path(root, event["session_id"]))
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def read_spool(root=SPOOL, *, now=None):
    now = time.time() if now is None else now
    for path in Path(root).glob("*.json"):
        try:
            if path.stat().st_size > 4096: continue
            event = json.loads(path.read_text())
            if not isinstance(event, dict): continue
            timestamp = event.get("timestamp")
            session = event.get("session_id")
            turn = event.get("turn_id", "")
            source = event.get("source", "chatgpt")
            state = event.get("state")
            if not isinstance(session, str) or not session or len(session) > 200: continue
            if not isinstance(turn, str) or len(turn) > 200: continue
            if not isinstance(source, str) or source not in profiles.sources(): continue
            if not isinstance(state, str) or state not in {"working", "waiting", "done", "error", "stopped", "unknown"}: continue
            if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)): continue
            try: timestamp = float(timestamp)
            except OverflowError: continue
            if not math.isfinite(timestamp): continue
            if -60 <= now - timestamp <= 1812:
                yield {"session_id": session, "turn_id": turn, "source": source,
                       "state": state, "timestamp": timestamp,
                       "cwd": Path(str(event.get("cwd", ""))).name[:100]}
        except (OSError, ValueError, AttributeError):
            continue
