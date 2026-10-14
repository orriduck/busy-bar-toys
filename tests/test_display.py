import unittest
from types import SimpleNamespace

from busybar_status.display import render, make_payload, to_xpm


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


if __name__ == "__main__":
    unittest.main()
