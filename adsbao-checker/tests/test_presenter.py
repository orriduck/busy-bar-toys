import copy
import unittest
from adsbao_checker.traffic import parse_envelope
from adsbao_checker.proximity import EncounterTracker
from adsbao_checker.presenter import AircraftPresenter
from test_proximity import envelope
from types import SimpleNamespace


class Device:
    def __init__(self):self.draws=[];self.uploads=[];self.clears=0;self.accept=True
    def draw(self,payload):self.draws.append(copy.deepcopy(payload));return self.accept
    def upload_asset(self,name,data):self.uploads.append((name,data))
    def clear(self):self.clears+=1


class PresenterTests(unittest.TestCase):
    def setUp(self):
        self.clock=[100.0];self.api=Device()
        frame=parse_envelope(envelope(),now=1000)
        self.plane=EncounterTracker().candidate(frame,SimpleNamespace(latitude=0,longitude=0),now=1000)
        self.presenter=AircraftPresenter(self.api,clock=lambda:self.clock[0])

    def test_ten_visible_seconds_then_fade_and_yield_to_coordinator(self):
        self.assertTrue(self.presenter.start(self.plane,demo=True))
        self.assertTrue(self.presenter.active)
        self.clock[0]=110.49;self.assertFalse(self.presenter.advance())
        self.clock[0]=110.51;self.assertFalse(self.presenter.advance())
        self.assertEqual(self.presenter.phase,'exit')
        self.clock[0]=110.8;self.assertTrue(self.presenter.advance())
        self.assertFalse(self.presenter.active)
        self.assertEqual(self.api.clears,0)
        last=self.api.draws[-1]['elements']
        self.assertEqual(last[0]['id'],'plane-view')
        self.assertIn('transparent',last[0]['path'])

    def test_focus_rejection_does_not_start_an_alert(self):
        self.api.accept=False
        self.assertFalse(self.presenter.start(self.plane))
        self.assertFalse(self.presenter.active)

    def test_button_dismisses_without_waiting_ten_seconds(self):
        self.presenter.start(self.plane)
        self.presenter.dismiss()
        self.assertEqual(self.presenter.phase,'exit')
        self.clock[0]+=.3;self.assertTrue(self.presenter.advance())

    def test_reduced_motion_is_static_and_releases_without_fade(self):
        self.presenter=AircraftPresenter(self.api,reduced=True,clock=lambda:self.clock[0])
        self.presenter.start(self.plane)
        self.assertEqual(self.api.uploads,[])
        self.assertFalse(any(e['type']=='animation' for e in self.api.draws[-1]['elements']))
        self.presenter.dismiss();self.assertTrue(self.presenter.advance())
