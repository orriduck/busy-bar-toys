import unittest

from busybar_notifier.model import Notification
from busybar_notifier.queue import NotificationQueue


def item(id, level="info", group=None, hold=None):
    return Notification(id, level, "test", "TEST", id.upper(), group=group, hold=hold)


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.now = [0.0]
        self.queue = NotificationQueue(clock=lambda: self.now[0])

    def tick(self, seconds):
        for _ in range(int(seconds / 2)):
            top, _ = self.queue.current()
            if top:
                self.queue.mark_shown(top.id)
            self.now[0] += 2

    def test_level_order_and_groups(self):
        self.queue.push([item("team-pr", "info", "pr:1"), item("review", "attention", "pr:1"), item("other")])
        top, extra = self.queue.current()
        self.assertEqual((top.id, extra), ("review", 1))
        self.queue.set_state("pages", [item("page", "urgent")])
        self.assertEqual(self.queue.current()[0].id, "page")

    def test_new_events_beat_standing_conditions(self):
        self.queue.set_state("auth", [item("login", "attention")])
        self.queue.push([item("done")])
        self.assertEqual(self.queue.current()[0].id, "done")
        self.queue.mark_shown("done")
        self.now[0] = 11
        self.assertEqual(self.queue.current()[0].id, "login")

    def test_non_urgent_items_hide_after_ten_seconds_and_take_their_group(self):
        self.queue.push([item("review", "attention", "pr:1"), item("team-pr", "info", "pr:1")])
        self.queue.mark_shown("review")
        self.now[0] = 9
        self.assertEqual(self.queue.current()[0].id, "review")
        self.now[0] = 11
        self.assertEqual(self.queue.current(), (None, 0))

    def test_urgent_items_stay_until_their_condition_clears(self):
        self.queue.set_state("pages", [item("page", "urgent")])
        self.queue.mark_shown("page")
        self.now[0] = 3600
        self.assertEqual(self.queue.current()[0].id, "page")

    def test_hold_and_snooze_are_configurable(self):
        queue = NotificationQueue(clock=lambda: self.now[0], hold=30, snooze=60)
        queue.push([item("ci", "attention")])
        queue.mark_shown("ci")
        self.now[0] = 20
        self.assertEqual(queue.current()[0].id, "ci")
        self.now[0] = 31
        self.assertIsNone(queue.current()[0])

    def test_custom_hold(self):
        self.queue.push([item("plane", hold=11.8)])
        self.queue.mark_shown("plane")
        self.now[0] = 11
        self.assertEqual(self.queue.current()[0].id, "plane")
        self.now[0] = 12
        self.assertIsNone(self.queue.current()[0])

    def test_dismissed_state_returns_only_after_it_clears(self):
        self.queue.set_state("pages", [item("page", "urgent")])
        self.queue.dismiss("page")
        self.assertIsNone(self.queue.current()[0])
        self.queue.set_state("pages", [])
        self.queue.current()
        self.queue.set_state("pages", [item("page", "urgent")])
        self.assertEqual(self.queue.current()[0].id, "page")

    def test_standing_condition_counts_only_visible_time_then_snoozes(self):
        self.queue.set_state("monitors", [item("monitor", "attention")])
        self.tick(4)
        self.queue.push([item("ci", "attention")])
        self.tick(14)
        self.assertEqual(self.queue.current()[0].id, "monitor", "Time behind another item does not count")
        self.tick(10)
        self.assertIsNone(self.queue.current()[0])
        self.now[0] += 31 * 60
        self.assertEqual(self.queue.current()[0].id, "monitor")

    def test_dismiss_all_keeps_urgent(self):
        self.queue.push([item("pr"), item("ci", "attention")])
        self.queue.set_state("auth", [item("login", "attention")])
        self.queue.set_state("pages", [item("page", "urgent")])
        self.queue.dismiss_all_except_urgent()
        self.assertEqual(self.queue.current(), (item("page", "urgent"), 0))
        self.queue.set_state("pages", [])
        self.assertIsNone(self.queue.current()[0])


if __name__ == "__main__":
    unittest.main()
