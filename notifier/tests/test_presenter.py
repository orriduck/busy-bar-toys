import copy
import unittest

from busybar_notifier import display
from busybar_shared.native import FPS
from busybar_notifier.model import Notification
from busybar_notifier.presenter import NotificationPresenter
from busybar_shared.graphics import to_xpm
from PIL import Image


class Device:
    def __init__(self):
        self.draws, self.uploads, self.clears, self.accept = [], [], 0, True

    def draw(self, payload):
        self.draws.append(copy.deepcopy(payload))
        return self.accept

    def upload_asset(self, name, data):
        self.uploads.append((name, data))

    def clear(self):
        self.clears += 1


def ids(draw):
    return {e["id"]: e for e in draw["elements"]}


class PresenterTest(unittest.TestCase):
    def test_final_title_is_not_visible_before_the_entrance_loads(self):
        self.presenter.start(self.short)
        self.assertEqual(ids(self.api.draws[-1])["front"]["data"],
                         to_xpm(Image.new("RGB", (72, 16), "black")))
        self.clock[0] += display.entrance_seconds(self.short) + .01
        self.presenter.advance()
        self.assertEqual(ids(self.api.draws[-1])["front"]["data"],
                         to_xpm(display.render(self.short, settled=True)[0]))

    def test_reduced_motion_exit_hides_native_text_before_restoration(self):
        self.presenter = NotificationPresenter(self.api, reduced=True, clock=lambda: self.clock[0])
        self.presenter.start(self.long)
        widgets=ids(self.api.draws[-1])
        self.assertEqual(widgets['notice-detail']['text'], self.long.detail)
        self.presenter.dismiss()
        self.assertTrue(self.presenter.advance())
        for draw in self.api.draws[1:]: widgets.update(ids(draw))
        self.assertFalse(widgets['notice-title']['text'].strip())
        self.assertFalse(widgets['notice-detail']['text'].strip())

    def setUp(self):
        self.clock = [100.0]
        self.api = Device()
        self.presenter = NotificationPresenter(self.api, clock=lambda: self.clock[0])
        self.short = Notification("n1", "info", "github", "GITHUB", "NEW PR", "REPO #1", accent=(110, 118, 129))
        self.long = Notification("n2", "attention", "jira", "JIRA", "TICKET ASSIGNED",
                                 "DEMO-1 a summary that is far too long for the line")

    def test_entrance_then_settled_view_then_fade_and_handoff(self):
        self.assertTrue(self.presenter.start(self.short, led="#6E7681FF"))
        first = self.api.draws[-1]
        intro = ids(first)["notice-view"]
        self.assertEqual((intro["section"], intro["loop"], intro["await_previous_end"]), ("enter", False, False))
        self.assertEqual(first["led_notification_color"], "#6E7681FF")
        settle_at = 100 + display.entrance_seconds(self.short)
        self.clock[0] = settle_at - .01
        self.presenter.advance()
        self.assertEqual([set(ids(d)) for d in self.api.draws[1:]], [{"notice-detail"}])
        self.clock[0] = settle_at + .01
        self.assertFalse(self.presenter.advance())
        settled = self.api.draws[-1]
        self.assertIn("transparent", ids(settled)["notice-view"]["path"])
        self.assertNotIn("led_notification_color", settled)
        self.presenter.dismiss()
        self.assertEqual(self.presenter.phase, "exit")
        self.clock[0] += .3
        self.assertTrue(self.presenter.advance())
        self.assertFalse(self.presenter.active)
        self.assertEqual(self.api.clears, 0)
        self.assertIn("transparent", ids(self.api.draws[-1])["notice-view"]["path"])

    def test_refresh_does_not_replay_the_entrance(self):
        self.presenter.start(self.short)
        self.clock[0] += display.entrance_seconds(self.short) + 6
        self.presenter.advance()
        self.presenter.advance()
        self.clock[0] += 5
        self.presenter.advance()
        self.assertTrue(all("enter" not in str(ids(d)["notice-view"].get("section"))
                            for d in self.api.draws[1:] if "notice-view" in ids(d)))

    def test_long_text_becomes_native_scrolling_text_after_the_entrance(self):
        self.presenter.start(self.long)
        self.assertNotIn("notice-title", ids(self.api.draws[-1]))
        self.clock[0] += display.entrance_seconds(self.long) + .01
        self.presenter.advance()
        settled = ids(self.api.draws[-1])
        self.assertEqual((settled["notice-title"]["text"], settled["notice-title"]["font"]), ("TICKET ASSIGNED", "bold"))
        self.assertNotIn("notice-detail", settled)
        self.assertGreater(settled["notice-title"]["scroll_rate"], 0)

    def test_detail_appears_once_the_icon_enters_and_is_not_redrawn(self):
        self.presenter.start(self.short)
        self.assertNotIn("notice-detail", ids(self.api.draws[-1]))
        self.clock[0] += display.ICON_ENTER_FRAMES / FPS + .01
        self.presenter.advance()
        detail = ids(self.api.draws[-1])
        self.assertEqual(set(detail), {"notice-detail"})
        self.assertEqual(detail["notice-detail"]["font"], "small")
        self.assertGreater(detail["notice-detail"]["scroll_rate"], 0)
        self.clock[0] = 100 + display.entrance_seconds(self.short) + .01
        self.presenter.advance()
        self.assertFalse({"notice-title", "notice-detail"} & set(ids(self.api.draws[-1])))
        count = len(self.api.draws)
        for _ in range(10):
            self.clock[0] += 5
            self.presenter.advance()
        text = [i for i, d in enumerate(self.api.draws[count:]) if "notice-detail" in ids(d)]
        self.assertEqual(len(text), 1, "Native text renews only before its timeout")

    def test_native_text_is_printable_ascii(self):
        self.assertEqual(display.ascii_text("修复 bug ✓"), "?? bug ?")

    def test_focus_rejection_does_not_start(self):
        self.api.accept = False
        self.assertFalse(self.presenter.start(self.short))
        self.assertFalse(self.presenter.active)

    def test_reduced_motion_is_static_and_releases_without_fade(self):
        self.presenter = NotificationPresenter(self.api, reduced=True, clock=lambda: self.clock[0])
        self.presenter.start(self.long)
        self.assertEqual(self.api.uploads, [])
        self.assertFalse(any(e["type"] == "animation" for e in self.api.draws[-1]["elements"]))
        self.assertIn("notice-title", ids(self.api.draws[-1]))
        self.presenter.dismiss()
        self.assertTrue(self.presenter.advance())

    def test_urgent_items_use_the_focus_priority(self):
        page = Notification("p", "urgent", "datadog", "DATADOG", "PAGED!")
        self.assertEqual(display.payload(page)["priority"], 100)
        self.assertEqual(display.payload(self.short)["priority"], 50)


class TitleTest(unittest.TestCase):
    def test_slightly_wide_titles_compress_and_long_titles_clip(self):
        self.assertTrue(display.title_fits("WWWW8888"))
        self.assertEqual(display.title_image("WWWW8888").width, display.TEXT_WIDTH)
        self.assertFalse(display.title_fits("TICKET ASSIGNED"))
        clipped = display.title_image("TICKET ASSIGNED")
        self.assertEqual(clipped.width, display.TEXT_WIDTH)
        self.assertEqual(clipped.tobytes(), display.title_image("TICKET ASSIGNED", 255).crop((0, 0, display.TEXT_WIDTH, 7)).tobytes())

    def test_entrance_length_is_fixed_up_to_eight_characters(self):
        short = Notification("a", "info", "x", "ADSBAO", "AAL7")
        eight = Notification("b", "info", "x", "ADSBAO", "JBU46288")
        self.assertEqual(display.entrance_frames(short), display.entrance_frames(eight))
        self.assertGreaterEqual(display.entrance_frames(Notification("c", "info", "x", "JIRA", "TICKET ASSIGNED")),
                                display.entrance_frames(eight))

    def test_last_entrance_frame_matches_the_final_view(self):
        item = Notification("a", "info", "x", "GITHUB", "NEW PR", "REPO #1")
        total = display.entrance_frames(item)
        self.assertEqual(display.render(item, progress=1)[0].tobytes(),
                         display.render(item, progress=(total - 1) / (total - 1))[0].tobytes())


if __name__ == "__main__":
    unittest.main()


class PriorityDevice(Device):
    """Reject draws below the namespace's current priority, like firmware 1.2.4."""
    def __init__(self):
        super().__init__()
        self.priority = 0

    def draw(self, payload):
        if payload["priority"] < self.priority:
            self.draws.append(None)
            return False
        self.priority = max(self.priority, payload["priority"])
        return super().draw(payload)

    def clear(self):
        super().clear()
        self.priority = 0


class SequenceTest(unittest.TestCase):
    def test_urgent_then_info_resets_the_priority_and_fades_at_the_same_priority(self):
        clock = [0.0]
        api = PriorityDevice()
        presenter = NotificationPresenter(api, clock=lambda: clock[0])
        page = Notification("p", "urgent", "datadog", "DATADOG", "PAGED!", "#1")
        info = Notification("i", "info", "github", "GITHUB", "NEW PR", "REPO #1")
        self.assertTrue(presenter.start(page))
        clock[0] += 3
        presenter.advance()
        presenter.dismiss()
        self.assertEqual(presenter.phase, "exit", "The fade uses the page priority")
        clock[0] += .3
        self.assertTrue(presenter.advance())
        self.assertEqual(api.clears, 1, "Leaving an urgent item resets the namespace priority")
        self.assertTrue(presenter.start(info))
        self.assertNotIn(None, api.draws)

    def test_every_start_removes_a_previous_opaque_fade_mask(self):
        clock = [0.0]
        api = Device()
        presenter = NotificationPresenter(api, clock=lambda: clock[0])
        first = Notification("a", "info", "github", "GITHUB", "NEW PR")
        second = Notification("b", "info", "github", "GITHUB", "PR COMMIT")
        presenter.start(first)
        presenter.dismiss()
        clock[0] += .3
        presenter.advance()
        self.assertIn("transparent", ids(api.draws[-1])["motion-view"]["path"])
        presenter.start(second)
        self.assertIn("transparent", ids(api.draws[-1])["motion-view"]["path"])
