import unittest
from types import SimpleNamespace

from busybar_status.display import render, make_payload, to_xpm, clock_text, thinking_offset
from datetime import datetime, timezone


class DisplayTests(unittest.TestCase):
    def task(self, source="chatgpt", state="working", project="中文项目"):
        return SimpleNamespace(source=source, state=state, project=project,
                               started_at=100, updated_at=100)

    def test_both_screens_fit_exactly(self):
        front, back = render(self.task(), 225, 2)
        self.assertEqual(front.size, (72, 16))
        self.assertEqual(back.size, (160, 80))
        self.assertGreater(front.getbbox()[2], 16)

    def test_dots_has_distinct_source_icon(self):
        front, _ = render(self.task("chatgpt"), 100, 1)
        dots, _ = render(self.task("dots"), 100, 1)
        self.assertNotEqual(front.crop((0, 0, 16, 16)).tobytes(),
                            dots.crop((0, 0, 16, 16)).tobytes())

    def test_xpm_is_ascii_and_has_complete_rows(self):
        for screen in render(self.task(), 120, 1):
            xpm = to_xpm(screen)
            self.assertTrue(xpm.isascii())
            rows = xpm.splitlines()
            width, height, colors, cpp = map(int, rows[1].split())
            self.assertEqual((width, height), screen.size)
            self.assertLessEqual(colors, 16)
            self.assertEqual(cpp, 1)
            self.assertEqual(len(rows[2 + colors:]), height)
            self.assertTrue(all(len(row) == width for row in rows[2 + colors:]))

    def test_payload_expires_and_respects_focus_priority(self):
        payload = make_payload(self.task(state="waiting"), 110, 1)
        self.assertEqual(payload["application_name"], "ai-status")
        self.assertEqual(payload["priority"], 50)
        self.assertEqual({e["display"] for e in payload["elements"]}, {"front", "back"})
        self.assertTrue(all(e["timeout"] == 15 for e in payload["elements"]))
        self.assertTrue(all(e["type"] == "xpmbitmap" for e in payload["elements"]))

    def test_clock_uses_new_york_time_including_daylight_saving(self):
        summer = datetime(2026, 7, 1, 12, 34, tzinfo=timezone.utc).timestamp()
        winter = datetime(2026, 12, 1, 12, 34, tzinfo=timezone.utc).timestamp()
        self.assertEqual(clock_text(summer), "08:34")
        self.assertEqual(clock_text(winter), "07:34")

    def test_clock_remains_visible_and_identical_across_task_states(self):
        now = datetime(2026,10,14,22,34,tzinfo=timezone.utc).timestamp()
        work, _ = render(self.task(state="working"), now, 1)
        wait, _ = render(self.task(state="waiting"), now, 1)
        clock = work.crop((20,1,49,8))
        self.assertEqual(clock.tobytes(), wait.crop((20,1,49,8)).tobytes())
        self.assertIsNotNone(clock.getbbox())

    def test_thinking_moves_out_and_back_without_teleporting(self):
        # 92 frames at 30fps: left -> right -> left, no endpoint hold.
        positions = [thinking_offset(frame/30) for frame in range(93)]
        self.assertEqual((positions[0],positions[46],positions[92]), (0,46,0))
        self.assertTrue(all(abs(b-a)==1 for a,b in zip(positions,positions[1:])))

    def test_work_uses_native_animation_and_other_states_replace_it(self):
        work = make_payload(self.task(), 100, 1)
        wait = make_payload(self.task(state="waiting"), 100, 1)
        animated = next(e for e in work["elements"] if e["id"]=="thinking")
        stopped = next(e for e in wait["elements"] if e["id"]=="thinking")
        self.assertEqual(animated["type"], "animation")
        self.assertTrue(animated["loop"])
        self.assertTrue(animated["await_previous_end"])
        self.assertEqual(stopped["type"], "xpmbitmap")


if __name__ == "__main__":
    unittest.main()
