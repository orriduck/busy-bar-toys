"""Translate local Codex rollout records into agent lifecycle events."""
from hashlib import sha256
import json
from pathlib import Path
import re

from busybar_agents.events import FLASH_SECONDS, STALE_SECONDS, STATES, TaskRegistry, parse_timestamp
from busybar_agents.tokens import parse_usage

TAIL_BYTES = 1024 * 1024
WAITING_TOOLS = frozenset({"request_user_input", "request_user_input_async"})


class CodexTaskRegistry(TaskRegistry):
    """Accept Codex rollout records as well as normalized lifecycle events."""

    def __init__(self):
        super().__init__()
        self._waiting_calls: dict[str, str] = {}
        self._default_session = ""

    def ingest(self, record: dict, now: float | None = None) -> bool:
        if not isinstance(record, dict):
            return False
        payload = record.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        if record.get("type") is not None and not isinstance(record["type"], str):
            return False
        if payload.get("type") is not None and not isinstance(payload["type"], str):
            return False
        if record.get("type") == "session_meta":
            session = payload.get("id") or record.get("session_id")
            if not isinstance(session, str) or not session:
                return False
            self._default_session = session
            source = payload.get("source")
            if isinstance(source, dict) and "subagent" in source:
                self.ignore(session)
                return False
            originator = payload.get("originator", "")
            client_meta = payload.get("responsesapi_client_metadata")
            client_meta = client_meta if isinstance(client_meta, dict) else {}
            is_dot = (isinstance(originator, str) and originator.startswith("orbit_cca")) or client_meta.get("aeon_kind") == "orbit"
            source = "dots" if is_dot or record.get("source") == "dots" else "codex"
            self.set_metadata(session, source, payload.get("cwd", ""), sticky=source == "dots")
            return False

        session = record.get("session_id") or self._default_session
        if not isinstance(session, str) or not session or self.is_ignored(session):
            return False
        current = self.task(session)
        state = record.get("state")
        kind = payload.get("type")
        usage = (parse_usage(payload["info"].get("total_token_usage"))
                 if record.get("type") == "event_msg" and kind == "token_count" and isinstance(payload.get("info"), dict) else None)
        if state is None and record.get("type") == "event_msg":
            state = {"task_started": "working", "task_complete": "done", "turn_aborted": "stopped", "error": "error"}.get(kind)
            if state is None and current and current.state in {"working", "waiting"} and kind in {"agent_message", "agent_reasoning", "token_count"}:
                state = current.state
        elif state is None and record.get("type") == "response_item":
            name = payload.get("name", "")
            name = name.rsplit(".", 1)[-1] if isinstance(name, str) else ""
            if kind == "function_call" and name in WAITING_TOOLS:
                state = "waiting" if not current or current.state in {"working", "waiting"} else None
            elif kind == "function_call_output" and current and current.state == "waiting":
                waiting_call = self._waiting_calls.get(session)
                state = "working" if waiting_call is None or payload.get("call_id") == waiting_call else "waiting"
            elif kind in {"function_call", "function_call_output", "message", "reasoning", "custom_tool_call", "custom_tool_call_output"} and current and current.state in {"working", "waiting"}:
                state = current.state
        if not isinstance(state, str) or state not in STATES:
            return False
        event_time = payload.get("started_at") if kind == "task_started" else payload.get("completed_at")
        started_at = parse_timestamp(payload.get("started_at")) if kind == "task_started" else None
        if not self._apply(session, state, record, now, payload=payload, event_time=event_time,
                           started_at=started_at, default_source="codex"):
            return False
        if usage is not None:
            self.set_usage(session, usage)
        turn = self.task(session).turn_id
        if state != "waiting" or (current and current.turn_id != turn):
            self._waiting_calls.pop(session, None)
        if state == "waiting" and kind == "function_call" and isinstance(payload.get("call_id"), str):
            self._waiting_calls[session] = payload["call_id"]
        return True


class RolloutWatcher:
    def __init__(self, sessions_dir: Path, registry: TaskRegistry, dot_thread_ids: set[str] | None = None):
        self.sessions_dir = Path(sessions_dir)
        self.registry = registry
        self.dot_thread_ids = set(dot_thread_ids or ())
        self._files: dict[Path, dict] = {}

    @staticmethod
    def _filename_id(path: Path) -> str:
        match = re.search(r"([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$", path.stem)
        return match.group(1) if match else path.stem

    @staticmethod
    def _tail_fingerprint(stream, offset: int) -> bytes:
        start = max(0, offset - 256)
        stream.seek(start)
        return sha256(stream.read(offset - start)).digest()

    @staticmethod
    def _is_boundary(record: dict) -> bool:
        payload = record.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        if isinstance(record.get("state"), str) and record["state"] in STATES:
            return True
        if record.get("type") == "event_msg":
            return isinstance(payload.get("type"), str) and payload["type"] in {"task_started", "task_complete", "turn_aborted", "error"}
        name = payload.get("name", "")
        return (record.get("type") == "response_item" and payload.get("type") == "function_call"
                and isinstance(name, str) and name.rsplit(".",1)[-1] in WAITING_TOOLS)

    @classmethod
    def _last_boundary(cls, stream, before: int) -> bytes | None:
        """Scan backwards in bounded chunks, skipping oversized non-lifecycle lines."""
        position = before
        buffer = b""
        skip_partial = True
        while position:
            size = min(position, 65536)
            position -= size
            stream.seek(position)
            pieces = (stream.read(size) + buffer).split(b"\n")
            buffer = pieces[0]
            for line in reversed(pieces[1:]):
                if skip_partial:
                    skip_partial = False
                    continue
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                if isinstance(record, dict) and cls._is_boundary(record):
                    return line
            if len(buffer) > TAIL_BYTES:
                buffer = b""
                skip_partial = True
        if buffer and not skip_partial:
            try:
                record = json.loads(buffer)
            except (ValueError, UnicodeDecodeError):
                return None
            if isinstance(record, dict) and cls._is_boundary(record):
                return buffer
        return None

    def _apply(self, line: bytes, info: dict, now: float, boot: bool) -> bool:
        try:
            record = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            return False
        if not isinstance(record, dict):
            return False
        payload = record.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        if record.get("type") == "session_meta":
            session = payload.get("id")
            if isinstance(session, str) and session:
                info["session"] = session
            source = payload.get("source")
            if isinstance(source, dict) and "subagent" in source:
                info["ignored"] = True
        if info["ignored"] and record.get("type") != "session_meta":
            return False
        record["session_id"] = info["session"]
        if info["session"] in self.dot_thread_ids:
            record["source"] = "dots"
        if boot and record.get("type") != "session_meta" and not self._is_boundary(record):
            timestamp = parse_timestamp(record.get("timestamp"))
            if timestamp is None:
                timestamp = parse_timestamp(payload.get("started_at"))
            if timestamp is None:
                timestamp = parse_timestamp(payload.get("completed_at"))
            if timestamp is None or now - timestamp > STALE_SECONDS + FLASH_SECONDS:
                return False
        return self.registry.ingest(record, now=now)

    def poll(self, now: float) -> int:
        """Read complete newly appended lines; return applied lifecycle event count."""
        count = 0
        for path in sorted(self.sessions_dir.glob("**/*.jsonl")):
            try:
                stat = path.stat()
                info = self._files.get(path)
                if info is None and now - stat.st_mtime > STALE_SECONDS:
                    continue
                boot = info is None or stat.st_size < info["offset"] or stat.st_ino != info["inode"]
                if not boot and (stat.st_mtime_ns != info.get("mtime_ns") or stat.st_ctime_ns != info.get("ctime_ns")):
                    with path.open("rb") as stream:
                        boot = self._tail_fingerprint(stream, info["offset"]) != info.get("fingerprint")
                if boot:
                    info = {"offset": max(0, stat.st_size - TAIL_BYTES), "buffer": b"", "session": self._filename_id(path), "ignored": False, "inode": stat.st_ino}
                    self._files[path] = info
                with path.open("rb") as stream:
                    if boot and info["offset"]:
                        header = stream.readline(65536)
                        if header.endswith(b"\n"):
                            self._apply(header, info, now, True)
                    if boot and info["offset"]:
                        stream.seek(info["offset"] - 1)
                        at_boundary = stream.read(1) == b"\n"
                        if not at_boundary:
                            stream.readline()  # The first tail line begins inside JSON.
                        tail_start = stream.tell()
                        if not info["ignored"]:
                            boundary = self._last_boundary(stream, tail_start)
                            if boundary:
                                count += bool(self._apply(boundary, info, now, True))
                        stream.seek(tail_start)
                    else:
                        stream.seek(info["offset"])
                    data = stream.read()
                    info["offset"] = stream.tell()
                    info["fingerprint"] = self._tail_fingerprint(stream, info["offset"])
                    info["mtime_ns"] = stat.st_mtime_ns
                    info["ctime_ns"] = stat.st_ctime_ns
                lines = (info["buffer"] + data).split(b"\n")
                info["buffer"] = lines.pop()
                for line in lines:
                    count += bool(self._apply(line, info, now, boot))
            except OSError:
                continue
        return count
