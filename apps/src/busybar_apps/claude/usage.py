"""Throughput of the latest completed Claude Code reply, read from local transcripts.

Usage fields and record timestamps only, never message text. Each assistant
message is written with its final usage when the reply ends; nothing is written
while it generates. A reply starts at the record its first row points to through
parentUuid (the request context, usually an attachment or the user/tool result)
and ends at its last row. The duration includes first-token latency and thinking
but not tool execution, which starts the next reply. Input is fresh input plus
cache writes; cache reads re-send earlier context and are excluded.
"""
from collections import OrderedDict
from datetime import datetime
import json
import os
from pathlib import Path
import re
import time

from busybar_agents.tokens import SourceUsage, TokenUsage

ROOT = Path.home() / ".claude" / "projects"
MAX_MESSAGES = 4096
MAX_TIMES = 16384
CHUNK = 1 << 20
SETTLE_SECONDS = 3
RECORD = re.compile(rb'"uuid":"([0-9a-f-]{36})","timestamp":"([^"]+)"')


def _stamp(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (AttributeError, TypeError, ValueError):
        return None


class TranscriptUsage:
    def __init__(self, root=ROOT, clock=time.time):
        self.root = Path(root)
        self.clock = clock
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
                                         "messages": OrderedDict(), "open": None, "latest": None}
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
        current = state["messages"].get(state["open"])
        if current and current["end"] is not None and self.clock() - current["end"] >= SETTLE_SECONDS:
            self._complete(state)
        latest = state["latest"]
        return SourceUsage(throughput=latest[1] if latest else None)

    def _line(self, state, line):
        found = RECORD.findall(line)
        uuid, stamp = (found[-1][0].decode(), _stamp(found[-1][1].decode())) if found else (None, None)
        message = self._assistant(line)
        if message is None:
            if uuid is not None and state["open"] is not None:
                self._complete(state)
        else:
            key, parent, usage = message
            if state["open"] not in (None, key):
                self._complete(state)
            messages = state["messages"]
            entry = messages.get(key)
            if entry is None:
                entry = messages[key] = {"start": state["times"].get(parent), "end": stamp, "usage": usage}
                while len(messages) > MAX_MESSAGES:
                    messages.popitem(last=False)
            else:
                if stamp is not None and (entry["end"] is None or stamp > entry["end"]):
                    entry["end"] = stamp
                entry["usage"] = tuple(max(a, b) for a, b in zip(entry["usage"], usage))
            state["open"] = key
        if uuid is not None and stamp is not None:
            times = state["times"]
            times[uuid] = stamp
            while len(times) > MAX_TIMES:
                times.popitem(last=False)

    @staticmethod
    def _assistant(line):
        if b'"usage"' not in line or b'"assistant"' not in line:
            return None
        try:
            record = json.loads(line)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return None
        if not isinstance(record, dict) or record.get("type") != "assistant" or record.get("isSidechain") is True:
            return None
        message = record.get("message")
        if not isinstance(message, dict):
            return None
        usage, key = message.get("usage"), message.get("id")
        if not isinstance(usage, dict) or not isinstance(key, str):
            return None
        def count(name):
            value = usage.get(name, 0)
            return value if type(value) is int and value >= 0 else 0
        return key, record.get("parentUuid"), (count("input_tokens") + count("cache_creation_input_tokens"),
                                               count("output_tokens"))

    @staticmethod
    def _complete(state):
        entry = state["messages"].get(state["open"])
        state["open"] = None
        if not entry or entry["start"] is None or entry["end"] is None or entry.get("done"):
            return
        entry["done"] = True
        duration = entry["end"] - entry["start"]
        if duration <= 0:
            return
        if state["latest"] is None or entry["end"] >= state["latest"][0]:
            counted, output = entry["usage"]
            state["latest"] = (entry["end"], TokenUsage(int(counted / duration), int(output / duration)))


TRANSCRIPTS = TranscriptUsage()
