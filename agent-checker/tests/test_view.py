import tempfile
import unittest
from pathlib import Path

from busybar_agents.view import ViewMode
from busybar_agents.events import TaskRegistry


class ViewTests(unittest.TestCase):
    def test_start_keeps_calendar_until_a_new_turn_not_an_existing_task_change(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'view.json'
            mode=ViewMode(path)
            old={('a','turn1'),('b','turn1')}
            self.assertTrue(mode.allows(old))
            mode.dismiss(old)
            self.assertFalse(mode.allows(old))
            self.assertFalse(mode.allows({('b','turn1')}))
            self.assertFalse(mode.allows(set()))
            self.assertFalse(ViewMode(path).allows(old))
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            self.assertTrue(mode.allows({('a','turn2')}))
            self.assertTrue(ViewMode(path).allows(set()))

    def test_another_press_in_calendar_does_not_reset_baseline_or_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            mode=ViewMode(Path(directory)/'view.json')
            mode.dismiss({('a','one')})
            mode.dismiss({('b','new')})
            self.assertTrue(mode.allows({('b','new')}))

    def test_corrupted_saved_state_stays_on_calendar_until_a_new_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'view.json'
            path.write_text('broken')
            mode=ViewMode(path)
            self.assertFalse(mode.allows({('a','old')}))
            self.assertFalse(mode.allows({('a','old')}))
            self.assertTrue(mode.allows({('a','new')}))

    def test_dismissed_stale_turn_cannot_resume_after_a_late_heartbeat(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'view.json'
            mode=ViewMode(path)
            registry=TaskRegistry()
            registry.ingest({'session_id':'s','turn_id':'old','state':'working','timestamp':100})
            self.assertEqual(registry.active_turns(2000),frozenset())
            mode.dismiss(registry.known_turns())
            registry.ingest({'session_id':'s','timestamp':2001,'type':'event_msg','payload':{'type':'token_count'}})
            self.assertFalse(mode.allows(registry.active_turns(2001),known_turns=registry.known_turns()))
            self.assertFalse(ViewMode(path).allows(registry.active_turns(2001),known_turns=registry.known_turns()))
            registry.ingest({'session_id':'s','turn_id':'new','state':'working','timestamp':2002})
            self.assertTrue(mode.allows(registry.active_turns(2002),known_turns=registry.known_turns()))

    def test_corrupted_saved_view_baseline_includes_stale_known_turns(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'view.json'
            path.write_text('broken')
            mode=ViewMode(path)
            registry=TaskRegistry()
            registry.ingest({'session_id':'s','turn_id':'old','state':'working','timestamp':100})
            self.assertFalse(mode.allows(registry.active_turns(2000),known_turns=registry.known_turns()))
            registry.ingest({'session_id':'s','timestamp':2001,'type':'event_msg','payload':{'type':'token_count'}})
            self.assertFalse(mode.allows(registry.active_turns(2001),known_turns=registry.known_turns()))
            registry.ingest({'session_id':'s','turn_id':'new','state':'working','timestamp':2002})
            self.assertTrue(mode.allows(registry.active_turns(2002),known_turns=registry.known_turns()))


if __name__=='__main__': unittest.main()
