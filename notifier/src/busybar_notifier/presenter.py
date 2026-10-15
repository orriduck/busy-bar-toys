"""Show one notification at a time: entrance, settled hold, fade out, namespace handoff."""
import time

from PIL import Image

from busybar_shared.native import encode_sections, fade_asset
from busybar_shared.native import FPS
from .display import (APP_NAME, ICON_ENTER_FRAMES, TEXT_TIMEOUT, detail_elements, entrance_asset,
                      entrance_seconds, payload)

REFRESH_SECONDS = 5
TEXT_REFRESH_SECONDS = TEXT_TIMEOUT - 15


def _priority(notification):
    return 100 if notification.level == "urgent" else 50


def _unmask():
    """Replace a finished opaque fade mask so it cannot cover the next view."""
    return {"id": "motion-view", "type": "animation", "display": "front", "x": 0, "y": 0, "z_index": 40,
            "timeout": 1, "path": "notice-transparent.anim", "loop": False, "await_previous_end": False}


def _hide_text():
    return [{"id": name, "type": "text", "display": "front", "text": " ", "font": "small",
             "x": 0, "y": 0, "z_index": 35, "timeout": 1} for name in ("notice-title", "notice-detail")]


class NotificationPresenter:
    def __init__(self, client, *, reduced=False, clock=None):
        self.client = client
        self.reduced = reduced
        self.clock = clock or time.monotonic
        self.phase = None
        self.current = None
        self._demo = False
        self._path = None
        self._sequence = 0
        self._settles_at = 0
        self._refresh_at = 0
        self._detail_at = None
        self._text_at = 0
        self._deadline = 0
        self._prepared = set()
        self._priority = 50

    @property
    def active(self):
        return self.phase is not None

    def _prepare(self):
        assets = {"notice-blank.anim": encode_sections((4, 16), {"hold": [Image.new("RGB", (4, 16))]}),
                  "notice-transparent.anim": encode_sections((72, 16), {"clear": [Image.new("RGBA", (72, 16))]}, rgba=True),
                  "notice-out.anim": fade_asset((72, 16), reveal=False, frames=6)}
        for name, data in assets.items():
            if name not in self._prepared:
                self.client.upload_asset(name, data)
                self._prepared.add(name)

    def start(self, notification, *, demo=False, led=None):
        if self.active:
            return False
        if self._priority > _priority(notification):
            # The namespace still holds a higher draw priority; reset it so lower items are accepted.
            self.client.clear()
            self._priority = 50
        self._sequence += 1
        path = f"notice-entry-{self._sequence % 2}.anim"
        if not self.reduced:
            self._prepare()
            self.client.upload_asset(path, entrance_asset(notification))
        body = payload(notification, demo=demo, reduced=self.reduced, path=path)
        if not self.reduced:
            body["elements"].append(_unmask())
        if led:
            body["led_notification_color"] = led
        if not self.client.draw(body):
            return False
        self.current, self._demo, self._path = notification, demo, path
        self._priority = _priority(notification)
        self.phase = "hold" if self.reduced else "intro"
        self._settles_at = self.clock() + (0 if self.reduced else entrance_seconds(notification))
        self._detail_at = None if self.reduced else self.clock() + ICON_ENTER_FRAMES / FPS
        self._refresh_at = self.clock() + REFRESH_SECONDS
        self._text_at = self.clock()
        return True

    def _draw_settled(self, *, text=False, detail=True):
        self.client.draw(payload(self.current, demo=self._demo, reduced=self.reduced, path=self._path,
                                 settled=True, text=text, detail=detail))
        self._refresh_at = self.clock() + REFRESH_SECONDS
        if text:
            self._text_at = self.clock()

    def _draw_detail(self):
        self._detail_at = None
        if elements := detail_elements(self.current):
            self.client.draw({"application_name": APP_NAME, "priority": self._priority, "elements": elements})

    def abandon(self):
        """Stop at once without drawing, because another host owns the display."""
        self.phase = None
        self.current = None
        self._priority = 50

    def dismiss(self):
        if self.phase not in ("intro", "hold"):
            return
        if self.reduced:
            self.client.draw({"application_name": APP_NAME, "priority": self._priority, "elements": _hide_text()})
            self.phase = "finished"
            return
        sent_at = self.clock()
        mask = {"id": "motion-view", "type": "animation", "display": "front", "x": 0, "y": 0, "z_index": 40,
                "timeout": 15, "path": "notice-out.anim", "loop": False, "await_previous_end": False}
        if not self.client.draw({"application_name": APP_NAME, "priority": self._priority, "elements": [mask]}):
            # Higher-priority device modes own the screen; release our state.
            self.phase = "finished"
            return
        self.phase = "exit"
        self._deadline = sent_at + .2

    def advance(self):
        """Return True once the coordinator must restore its latest base view."""
        if self.phase == "intro" and self._detail_at is not None and self.clock() >= self._detail_at:
            self._draw_detail()
        if self.phase == "intro" and self.clock() >= self._settles_at:
            if self._detail_at is not None:
                self._draw_detail()
            self._draw_settled(text=True, detail=False)
            self.phase = "hold"
        elif self.phase == "hold" and self.clock() >= self._refresh_at:
            self._draw_settled(text=self.clock() - self._text_at >= TEXT_REFRESH_SECONDS)
        if self.phase == "exit" and self.clock() >= self._deadline:
            transparent = {"id": "notice-view", "type": "animation", "display": "front", "x": 0, "y": 0,
                           "z_index": 30, "timeout": 1, "path": "notice-transparent.anim", "loop": False,
                           "await_previous_end": False}
            self.client.draw({"application_name": APP_NAME, "priority": self._priority,
                              "elements": [transparent, *_hide_text(), _unmask()]})
            self.phase = "finished"
        if self.phase == "finished":
            if self._priority > 50:
                self.client.clear()
                self._priority = 50
            self.phase = None
            self.current = None
            return True
        return False
