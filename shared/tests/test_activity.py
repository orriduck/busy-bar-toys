import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from busybar_shared.cloud import State
try:
    from busybar_shared.activity import ActivityPublisher
except ImportError:
    ActivityPublisher = None


class ActivityTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(ActivityPublisher, 'Shared activity publication is missing')
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.now = 100
        self.state = State(Path(folder.name)/'state.json', clock=lambda:self.now)
        self.producer = SimpleNamespace(state=self.state, clock=lambda:self.now)
        self.activity = ActivityPublisher(self.producer, 'activity', withdraw=True)

    def publish(self, identity='one', changes=None):
        self.activity.begin(identity)
        return self.activity.publish({'app':'game','kind':'condition','level':'info',
            'title':'WOW','detail':str(self.now),'scene':{'commands':[]},'actionKeys':[]}, changes)

    def test_time_updates_keep_occurrence_and_merge_unacknowledged_deltas(self):
        first = self.publish(changes=[{'id':'timer','text':'00:00'}])
        self.state.records['activity']['acked'] = first['version']
        self.now += 1
        self.publish(changes=[{'id':'timer','text':'00:01'}])
        self.now += 1
        self.publish(changes=[{'id':'other','text':'keep'}])
        record = self.state.records['activity']
        self.assertEqual(record['itemId'], first['itemId'])
        self.assertEqual({e['id']:e['text'] for e in record['update']}, {'timer':'00:01','other':'keep'})
        self.assertEqual(record['lastSourceAt'], 102000)

    def test_new_session_withdraws_old_occurrence_and_creates_a_new_one(self):
        first = self.publish()
        second = self.publish('two')
        self.assertNotEqual(first['itemId'], second['itemId'])
        self.assertTrue(self.state.data['ends'][first['itemId']]['withdraw'])

    def test_restart_same_session_keeps_id_and_user_dismissal_is_not_resurrected(self):
        first = self.publish()
        self.activity = ActivityPublisher(self.producer, 'activity', withdraw=True)
        self.assertEqual(self.publish()['itemId'], first['itemId'])
        self.state.tombstone(first['itemId'], 'cleared')
        self.assertIsNone(self.publish())
        self.assertNotEqual(self.publish('new')['itemId'], first['itemId'])

    def test_unknown_does_not_clear_and_only_fresh_renewal_restores_source(self):
        first = self.publish()
        self.now = 200
        self.activity.unknown()
        record = self.state.records['activity']
        self.assertTrue(record['sourceUnknown'])
        self.assertEqual(record['lastSourceAt'],100000)
        self.assertFalse(record.get('cleared',False))
        self.activity.renew()
        self.assertFalse(record['sourceUnknown'])
        self.assertEqual(record['lastSourceAt'],200000)
        self.activity.hide()
        self.assertTrue(self.state.data['ends'][first['itemId']]['withdraw'])
