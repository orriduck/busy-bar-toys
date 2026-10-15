"""Agent apps register their identity, icon, and hook mapping here."""
from dataclasses import dataclass, field
from typing import Callable

from PIL import Image


@dataclass(frozen=True)
class AgentProfile:
    source: str
    title: str
    icon: Callable[[int], Image.Image]
    hook_states: dict = field(default_factory=dict)
    waiting_tools: frozenset = frozenset()
    new_turn_events: frozenset = frozenset()
    aliases: frozenset = frozenset()
    accent: tuple | None = None


_PROFILES: dict[str, AgentProfile] = {}
_DEFAULT: list[str] = []


def register(profile, *, default=False):
    for name in {profile.source, *profile.aliases}:
        _PROFILES[name] = profile
    if default or not _DEFAULT:
        _DEFAULT[:] = [profile.source]


def sources():
    return frozenset(_PROFILES)


def profile(source):
    found = _PROFILES.get(source) or (_PROFILES.get(_DEFAULT[0]) if _DEFAULT else None)
    if found is None:
        raise LookupError("No agent app is registered.")
    return found
