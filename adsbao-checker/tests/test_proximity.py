import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from adsbao_checker.proximity import EncounterTracker, distance_metres
from adsbao_checker.traffic import parse_envelope


def envelope(now=1000, **aircraft):
    return {'channel':'nearby:0.00:0.00','sequence':1,'stale':False,
            'emittedAt':now,'fetchedAt':now,
            'data':{'aircraft':{'ac':[{'hex':'abc123','flight':'TEST123 ',
                'lat':0,'lon':.01,'fixAt':now,'alt_baro':10000,**aircraft}]}}}


class ProximityTests(unittest.TestCase):
    def setUp(self):
        self.fix=SimpleNamespace(latitude=0,longitude=0)
        self.tracker=EncounterTracker()

    def test_three_statute_mile_boundary(self):
        # One degree on the equator is approximately 111195 metres.
        inside=parse_envelope(envelope(lon=.0434),now=1000)
        outside=parse_envelope(envelope(lon=.0435),now=1000)
        self.assertIsNotNone(self.tracker.candidate(inside,self.fix,now=1000))
        self.assertIsNone(self.tracker.candidate(outside,self.fix,now=1000))
        self.assertAlmostEqual(distance_metres(0,0,0,1),111195,delta=1)

    def test_same_encounter_stays_suppressed_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'encounters.json'
            tracker=EncounterTracker(path)
            frame=parse_envelope(envelope(),now=1000)
            aircraft=tracker.candidate(frame,self.fix,now=1000)
            tracker.mark_alerted(aircraft,now=1000)
            self.assertIsNone(EncounterTracker(path).candidate(frame,self.fix,now=1001))
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            self.assertNotIn('lat',path.read_text())

    def test_rearms_only_after_sixty_seconds_beyond_outer_boundary(self):
        near=parse_envelope(envelope(),now=1000)
        plane=self.tracker.candidate(near,self.fix,now=1000)
        self.tracker.mark_alerted(plane,now=1000)
        far=parse_envelope(envelope(now=1030,lon=.06),now=1030)
        self.tracker.candidate(far,self.fix,now=1030)
        self.tracker.candidate(parse_envelope(envelope(now=1089,lon=.06),now=1089),self.fix,now=1089)
        self.assertIsNone(self.tracker.candidate(parse_envelope(envelope(now=1089),now=1089),self.fix,now=1089))
        self.tracker.candidate(parse_envelope(envelope(now=1100,lon=.06),now=1100),self.fix,now=1100)
        self.tracker.candidate(parse_envelope(envelope(now=1160,lon=.06),now=1160),self.fix,now=1160)
        self.assertIsNotNone(self.tracker.candidate(parse_envelope(envelope(now=1161),now=1161),self.fix,now=1161))

    def test_nearest_candidate_and_global_cooldown(self):
        payload=envelope(lon=.02)
        payload['data']['aircraft']['ac'].append({'hex':'def456','lat':0,'lon':.01,'fixAt':1000})
        frame=parse_envelope(payload,now=1000)
        nearest=self.tracker.candidate(frame,self.fix,now=1000)
        self.assertEqual(nearest.aircraft.hex,'def456')
        self.tracker.mark_alerted(nearest,now=1000)
        self.assertIsNone(self.tracker.candidate(frame,self.fix,now=1001))

    def test_older_aircraft_fix_cannot_move_a_plane_back_inside_the_radius(self):
        far=parse_envelope(envelope(now=1000,lon=.06),now=1000)
        self.assertIsNone(self.tracker.candidate(far,self.fix,now=1000))
        late=envelope(now=1001,lon=.01,fixAt=999);late['sequence']=2
        self.assertIsNone(self.tracker.candidate(parse_envelope(late,now=1001),self.fix,now=1001))
