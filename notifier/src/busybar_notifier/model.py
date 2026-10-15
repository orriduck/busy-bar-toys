"""Notification records and level rules."""
from dataclasses import dataclass, field
from typing import Callable

from PIL import Image

LEVELS = ("urgent", "attention", "info")
LEVEL_RANK = {level: rank for rank, level in enumerate(LEVELS)}
HOLD = 10.0
SNOOZE = 1800.0
URGENT_COLOR = (232, 72, 58)
ATTENTION_COLOR = (229, 165, 10)


@dataclass(frozen=True)
class Notification:
    id: str
    level: str
    app: str
    brand: str
    title: str
    detail: str = ""
    note: str = ""
    accent: tuple = (255, 255, 255)
    icon: Image.Image | None = field(default=None, compare=False, hash=False, repr=False)
    group: str | None = None
    primary: Callable[[], None] | None = field(default=None, compare=False, hash=False, repr=False)
    hold: float | None = None
    payload: object = field(default=None, compare=False, hash=False, repr=False)
    source: str | None = field(default=None, compare=False)

    def __post_init__(self):
        if self.level not in LEVEL_RANK:
            raise ValueError(f"Unknown notification level: {self.level}")

    def event_hold(self, default=HOLD):
        if self.hold is not None:
            return self.hold
        return float("inf") if self.level == "urgent" else default


def status_color(level, app_color):
    """Urgent and attention items use status colors; info items keep the app color."""
    return {"urgent": URGENT_COLOR, "attention": ATTENTION_COLOR}.get(level, app_color)
