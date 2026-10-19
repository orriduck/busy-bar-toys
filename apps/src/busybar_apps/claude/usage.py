"""Throughput of the latest completed Claude Code reply, read from local transcripts.

Usage fields and record timestamps only, never message text. Observed in real
transcripts: every row of an assistant message carries the same final usage and
a non-null stop_reason; only "tool_use" and "end_turn" were observed. A
"tool_use" reply can receive tool results on earlier rows while later rows are
still being written, but all of its rows precede the next assistant message, so
it completes when the next main-chain assistant message begins; its value
appears after the tool runs, not immediately. An "end_turn" reply never had an
outside child before its last row, so it completes when a later user or
attachment record (not progress or child-agent) points to one of its rows. Any
other or malformed stop_reason completes on either signal but has no
trustworthy measurement and shows unknown. There is no inactivity timeout. Completion order is the order in which
messages first appear in the file. A reply starts at the record its first row points to
through parentUuid (the request context, usually an attachment or the user/tool
result) and ends at its last row. The duration includes first-token latency and
thinking but not tool execution. Input is fresh input plus cache writes; cache
reads re-send earlier context and are excluded. If the newest completed reply has
no usable timing or usage, the result is unknown rather than an older reply.
"""
from collections import OrderedDict
from datetime import datetime
import json
import os
from pathlib import Path

from busybar_agents.tokens import SourceUsage, TokenUsage

ROOT = Path.home() / ".claude" / "projects"
MAX_MESSAGES = 4096
MAX_RECORDS = 16384
CHUNK = 1 << 20
CONTINUING = frozenset({"tool_use"})
SUPPORTED = frozenset({"tool_use", "end_turn"})
FOLLOWERS = frozenset({"user", "attachment"})


def _stamp(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _usage(value):
    """Counted input and output, or None when a count is missing or invalid."""
    if not isinstance(value, dict):
        return None
    counts = [value.get("input_tokens", 0), value.get("cache_creation_input_tokens", 0), value.get("output_tokens")]
    if any(type(count) is not int or count < 0 for count in counts):
        return None
    return counts[0] + counts[1], counts[2]


def _bounded(mapping, limit):
    while len(mapping) > limit:
        mapping.popitem(last=False)


class TranscriptUsage:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        self._files = {}

    def _allowed(self, path):
        try:
            resolved = Path(path).resolve(strict=True)
            return resolved.suffix == ".jsonl" and resolved.is_file() and resolved.is_relative_to(self.root.resolve())
        except (OSError, ValueError):
            return False

    def __call__(self, path):
        if not self._allowed(path):
            return None
        try:
            stat = os.stat(path)
        except OSError:
            return None
        state = self._files.get(path)
        if state is None or state["inode"] != stat.st_ino or stat.st_size < state["offset"]:
            state = self._files[path] = {"inode": stat.st_ino, "offset": 0, "times": OrderedDict(),
                                         "owners": OrderedDict(), "messages": OrderedDict(), "latest": None,
                                         "seq": 0}
        try:
            with open(path, "rb") as stream:
                stream.seek(state["offset"])
                while True:
                    chunk = stream.read(CHUNK)
                    if not chunk:
                        break
                    end = chunk.rfind(b"\n")
                    if end < 0:
                        if len(chunk) < CHUNK:
                            break
                        state["offset"] += len(chunk)
                        state["skip"] = True
                        continue
                    lines = chunk[:end].split(b"\n")
                    if state.pop("skip", False):
                        lines = lines[1:]
                    for line in lines:
                        self._line(state, line)
                    state["offset"] += end + 1
                    stream.seek(state["offset"])
        except OSError:
            return None
        return SourceUsage(throughput=self._throughput(state))

    @staticmethod
    def _throughput(state):
        entry = state["messages"].get(state["latest"])
        if (not entry or entry["stop"] not in SUPPORTED or entry["usage"] is None
                or entry["start"] is None or entry["end"] is None):
            return None
        duration = entry["end"] - entry["start"]
        if duration <= 0:
            return None
        counted, output = entry["usage"]
        return TokenUsage(int(counted / duration), int(output / duration))

    def _line(self, state, line):
        if not line.strip():
            return
        try:
            record = json.loads(line)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return
        if not isinstance(record, dict):
            return
        uuid, parent, stamp = record.get("uuid"), record.get("parentUuid"), _stamp(record.get("timestamp"))
        uuid = uuid if isinstance(uuid, str) and uuid else None
        parent = parent if isinstance(parent, str) and parent else None
        message = record.get("message")
        key = message.get("id") if isinstance(message, dict) else None
        own = (isinstance(message, dict) and record.get("type") == "assistant" and record.get("isSidechain") is not True
               and isinstance(key, str) and bool(key))
        owner = state["owners"].get(parent) if parent else None
        if (owner is not None and owner != (key if own else None) and record.get("type") in FOLLOWERS
                and record.get("isSidechain") is not True):
            follow = state["messages"].get(owner)
            if follow is not None:
                follow["followed"] = True
                self._promote(state, owner)
        if own:
            messages = state["messages"]
            entry = messages.get(key)
            if entry is None:
                state["seq"] += 1
                entry = messages[key] = {"start": state["times"].get(parent), "end": None, "usage": (0, 0),
                                         "stop": None, "followed": False, "superseded": False, "seq": state["seq"]}
                _bounded(messages, MAX_MESSAGES)
                for earlier, other in list(messages.items()):
                    if earlier != key and not other["superseded"]:
                        other["superseded"] = True
                        self._promote(state, earlier)
            usage = _usage(message.get("usage"))
            entry["usage"] = None if usage is None or entry["usage"] is None else tuple(
                max(a, b) for a, b in zip(entry["usage"], usage))
            if stamp is not None and (entry["end"] is None or stamp > entry["end"]):
                entry["end"] = stamp
            reason = message.get("stop_reason")
            if reason is not None:
                entry["stop"] = reason if isinstance(reason, str) and reason in SUPPORTED else "unsupported"
            if uuid:
                state["owners"][uuid] = key
                _bounded(state["owners"], MAX_RECORDS)
            self._promote(state, key)
        if uuid and stamp is not None:
            state["times"][uuid] = stamp
            _bounded(state["times"], MAX_RECORDS)

    @staticmethod
    def _promote(state, key):
        entry = state["messages"].get(key)
        if not entry or entry["stop"] is None:
            return
        if not (entry["superseded"] or (entry["followed"] and entry["stop"] not in CONTINUING)):
            return
        current = state["messages"].get(state["latest"])
        if current is None or entry["seq"] >= current["seq"]:
            state["latest"] = key


TRANSCRIPTS = TranscriptUsage()
