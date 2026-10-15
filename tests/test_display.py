import unittest
from types import SimpleNamespace

from busybar_status.display import render, make_payload, to_xpm, clock_text, thinking_offset
from datetime import datetime, timezone
from busybar_status.network import NetworkRates


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
        self.assertNotEqual(front.crop((11, 1, 25, 15)).tobytes(),
                            dots.crop((11, 1, 25, 15)).tobytes())

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
        clock = work.crop((33,1,63,8))
        self.assertEqual(clock.tobytes(), wait.crop((33,1,63,8)).tobytes())
        self.assertIsNotNone(clock.getbbox())

    def test_centered_clock_and_compact_rates_have_distinct_colored_arrows(self):
        now = 100
        slow = NetworkRates(123,456,'en0')
        fast = NetworkRates(4096,8192,'en0')
        front, _ = render(self.task(),now,1,slow)
        updated, _ = render(self.task(),now,1,fast)
        self.assertEqual(front.crop((28,0,72,9)).tobytes(),
                         updated.crop((28,0,72,9)).tobytes())
        self.assertNotEqual(front.crop((28,10,72,15)).tobytes(),
                            updated.crop((28,10,72,15)).tobytes())
        raw=front.crop((28,10,72,15)).tobytes()
        colors=set(zip(raw[0::3],raw[1::3],raw[2::3]))
        self.assertIn((255,190,69),colors)  # upload amber
        self.assertIn((69,215,255),colors)  # download cyan
        self.assertIn((80,80,80),colors)
        self.assertTrue(all(r==g==b or (r,g,b) in {(255,190,69),(69,215,255)}
                            for r,g,b in colors))
        for value in (slow,fast):
            im=render(self.task(),now,1,value)[0]
            self.assertEqual(im.crop((11,1,25,15)).tobytes(),
                             front.crop((11,1,25,15)).tobytes())
        bounds=updated.crop((7,0,72,16)).getbbox()
        self.assertLessEqual(abs((bounds[0]+bounds[2])/2-32.5),1)
        xpm=make_payload(self.task(),now,1,slow)['elements'][0]['data']
        self.assertIn('#FFBE45',xpm)
        self.assertIn('#45D7FF',xpm)

    def test_state_words_are_removed_from_both_screens(self):
        work, back = render(self.task(),100,1)
        wait, waiting_back = render(self.task(state='waiting'),100,1)
        self.assertEqual(work.crop((4,0,72,16)).tobytes(),
                         wait.crop((4,0,72,16)).tobytes())
        self.assertEqual(back.tobytes(),waiting_back.tobytes())

    def test_idle_keeps_clock_and_network_without_a_working_animation(self):
        front, back=render(None,100,0,NetworkRates(100,200,'en0'))
        self.assertIsNotNone(front.crop((20,0,72,14)).getbbox())
        self.assertIsNotNone(back.getbbox())
        payload=make_payload(None,100,0)
        self.assertTrue(all(e['type']!='animation' for e in payload['elements']))

    def test_demo_remains_identifiable_after_removing_project_and_state_text(self):
        task=self.task()
        normal=render(task,100)[1]
        task.session_id='demo'
        demo=render(task,100)[1]
        self.assertNotEqual(normal.crop((0,0,145,29)).tobytes(),
                            demo.crop((0,0,145,29)).tobytes())

    def test_thinking_moves_out_and_back_without_teleporting(self):
        # 92 frames at 30fps: top -> bottom -> top, with subpixel travel.
        positions = [thinking_offset(frame/30) for frame in range(93)]
        self.assertEqual((positions[0],positions[46],positions[92]), (1,14,1))
        self.assertTrue(all(0<abs(b-a)<1 for a,b in zip(positions,positions[1:])))

    def test_work_uses_native_animation_and_other_states_replace_it(self):
        work = make_payload(self.task(), 100, 1)
        wait = make_payload(self.task(state="waiting"), 100, 1)
        animated = next(e for e in work["elements"] if e["id"]=="thinking")
        stopped = next(e for e in wait["elements"] if e["id"]=="thinking")
        self.assertEqual(animated["type"], "animation")
        self.assertEqual((animated["x"],animated["y"]),(0,0))
        self.assertTrue(animated["loop"])
        self.assertTrue(animated["await_previous_end"])
        self.assertEqual(stopped["type"], "xpmbitmap")


if __name__ == "__main__":
    unittest.main()
