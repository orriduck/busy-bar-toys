import unittest
from busybar_agents.view import StandbyTimer
from busybar_apps import load_agents

load_agents()


class StandbyTimerTests(unittest.TestCase):
    def test_ten_seconds_from_first_successful_draw_and_refreshes_do_not_restart(self):
        timer=StandbyTimer()
        self.assertFalse(timer.expired(100))
        timer.shown(100)
        timer.shown(105)
        self.assertFalse(timer.expired(109.999))
        self.assertTrue(timer.expired(110))
        self.assertTrue(timer.expired(120))

    def test_new_activity_cancels_old_countdown_and_next_standby_rearms(self):
        timer=StandbyTimer()
        timer.shown(100)
        timer.reset()
        self.assertFalse(timer.expired(120))
        timer.shown(130)
        self.assertFalse(timer.expired(139.999))
        self.assertTrue(timer.expired(140))


if __name__=='__main__': unittest.main()
