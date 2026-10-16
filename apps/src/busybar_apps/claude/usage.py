"""Cumulative Claude Code token totals read from local transcripts. Usage fields only, never message text.

Input is fresh input plus cache writes; cache reads re-send earlier context and are excluded.
"""
from collections import OrderedDict
import json
import os
from pathlib import Path

from busybar_agents.tokens import TokenUsage

ROOT = Path.home() / ".claude" / "projects"
MAX_MESSAGES = 4096
CHUNK = 1 << 20


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
            state = self._files[path] = {"inode": stat.st_ino, "offset": 0, "messages": OrderedDict(), "base": [0, 0]}
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
        totals = [sum(values) for values in zip(state["base"], *state["messages"].values())] if state["messages"] else state["base"]
        return TokenUsage(*totals)

    @staticmethod
    def _line(state, line):
        if b'"usage"' not in line or b'"assistant"' not in line:
            return
        try:
            record = json.loads(line)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return
        if not isinstance(record, dict) or record.get("type") != "assistant":
            return
        message = record.get("message")
        if not isinstance(message, dict):
            return
        usage, key = message.get("usage"), message.get("id")
        if not isinstance(usage, dict) or not isinstance(key, str):
            return
        def count(name):
            value = usage.get(name, 0)
            return value if type(value) is int and value >= 0 else 0
        current = (count("input_tokens") + count("cache_creation_input_tokens"),
                   count("output_tokens"))
        messages = state["messages"]
        previous = messages.pop(key, (0, 0))
        messages[key] = tuple(max(a, b) for a, b in zip(previous, current))
        while len(messages) > MAX_MESSAGES:
            _, oldest = messages.popitem(last=False)
            state["base"] = [a + b for a, b in zip(state["base"], oldest)]


TRANSCRIPTS = TranscriptUsage()
