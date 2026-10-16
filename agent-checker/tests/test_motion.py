import copy
from datetime import datetime,timezone
from types import SimpleNamespace
import unittest
from busybar_agents.motion import MotionDirector
from busybar_agents.motion_assets import bar_name
from busybar_agents.tokens import TokenUsage
from busybar_apps import load_agents

load_agents()


class Device:
    def __init__(self):self.draws=[];self.uploads=[];self.clears=0;self.accept=True
    def draw(self,payload):self.draws.append(copy.deepcopy(payload));return self.accept
    def upload_asset(self,name,data):self.uploads.append(name)
    def clear(self):self.clears+=1


def task(state,source='chatgpt'):
    return SimpleNamespace(state=state,source=source,session_id='demo')


class MotionTests(unittest.TestCase):
    def setUp(self):
        self.now=[100.0];self.api=Device()
        self.motion=MotionDirector(self.api,clock=lambda:self.now[0])
        self.wall=datetime(2026,10,14,12,20,tzinfo=timezone.utc).timestamp()
        self.rates=TokenUsage(123,456)

    def show(self,state,**kwargs):
        return self.motion.show(task(state),kwargs.get('wall',self.wall),1,kwargs.get('rates',self.rates))

    def test_state_change_fades_old_light_then_commits_latest_target_without_clear(self):
        self.show('working');uploads=list(self.api.uploads)
        self.show('waiting')
        self.assertTrue(self.motion.pending)
        self.assertEqual(self.motion.current.state,'working')
        self.assertEqual({e['id'] for e in self.api.draws[-1]['elements']},{'motion-bar'})
        count=len(self.api.draws);self.show('error')
        self.assertEqual(len(self.api.draws),count)
        self.now[0]+=.3;self.motion.advance()
        strip=next(e for e in self.api.draws[-1]['elements'] if e['id']=='thinking')
        self.assertEqual(strip['path'],bar_name('error'))
        self.assertEqual(strip['type'],'animation')
        self.assertEqual(self.api.clears,0)
        self.assertEqual(self.api.uploads,uploads)

    def test_only_changed_digits_roll_and_unchanged_refresh_does_not_replay(self):
        self.show('waiting');self.now[0]+=1
        changed=TokenUsage(124,457)
        self.show('waiting',wall=self.wall+60,rates=changed)
        overlays=[e for e in self.api.draws[-1]['elements'] if e['id'].startswith('roll-')]
        self.assertEqual(len([e for e in overlays if 'clock' in e['id']]),1)
        self.assertEqual({e['id'] for e in overlays if 'rate' in e['id']},{'roll-rate-input-2','roll-rate-output-2'})
        self.assertEqual({e['x'] for e in overlays if 'rate' in e['id']},{40,56})
        self.assertTrue(all(e['timeout']==1 and not e['loop'] for e in overlays))
        self.assertEqual(len({name for name in self.api.uploads}),len(self.api.uploads))
        self.show('waiting',wall=self.wall+60,rates=changed)
        self.assertFalse(any(e['id'].startswith('roll-') for e in self.api.draws[-1]['elements']))

    def test_rate_width_change_uses_a_field_fade(self):
        self.show('waiting')
        self.show('waiting',rates=TokenUsage(1000,1000))
        self.assertEqual([e['id'] for e in self.api.draws[-1]['elements']],['motion-rate'])

    def test_coalesced_source_change_adds_its_own_mask(self):
        self.show('working');self.show('waiting')
        self.motion.show(task('waiting','dots'),self.wall,1,self.rates)
        self.assertEqual([e['id'] for e in self.api.draws[-1]['elements']],['motion-icon'])
        self.now[0]+=1;self.motion.advance()
        self.assertEqual(self.motion.current.source,'dots')
        self.assertTrue({'motion-bar','motion-icon'}<=
                        {e['id'] for e in self.api.draws[-1]['elements']})

    def test_new_turn_cancels_a_pending_calendar_exit(self):
        self.show('done');self.motion.hide()
        self.show('working');self.now[0]+=1;self.motion.advance()
        self.assertTrue(self.motion.visible)
        self.assertEqual(self.motion.current.state,'working')
        self.assertEqual(self.api.clears,0)

    def test_standby_waits_for_reveal_and_terminal_aliases_do_not_restart_a_fade(self):
        self.show('done')
        self.assertFalse(self.motion.standby_visible)
        self.show('stopped')
        self.assertFalse(self.motion.standby_visible)
        self.now[0]+=.5;self.assertTrue(self.motion.standby_visible)
        self.show('stopped')
        self.assertFalse(self.motion.pending)
        self.assertTrue(self.motion.standby_visible)
        self.motion.hide();self.assertEqual(self.api.clears,0)
        self.now[0]+=.5;self.motion.advance()
        self.assertEqual(self.api.clears,1)
        self.assertFalse(self.motion.visible)

    def test_reduced_motion_has_no_native_animation_and_releases_immediately(self):
        self.motion=MotionDirector(self.api,reduced=True,clock=lambda:self.now[0])
        self.show('working')
        self.assertFalse(self.api.uploads)
        self.assertTrue(all(e['type']!='animation' for e in self.api.draws[-1]['elements']))
        self.motion.hide();self.assertEqual(self.api.clears,1)

    def test_focus_conflict_does_not_commit_unseen_state(self):
        self.api.accept=False
        self.assertFalse(self.show('waiting'))
        self.assertIsNone(self.motion.current)
        self.assertFalse(self.motion.visible)

    def test_decimal_format_change_fades_instead_of_rolling_a_decimal_point(self):
        self.show('waiting',rates=TokenUsage(0,99000))
        self.show('waiting',rates=TokenUsage(0,100000))
        self.assertEqual([e['id'] for e in self.api.draws[-1]['elements']],['motion-rate'])

    def test_same_total_with_independent_direction_changes_updates_both_digits(self):
        self.show('waiting',rates=TokenUsage(123,456));self.now[0]+=1
        self.show('waiting',rates=TokenUsage(124,455))
        rolls=[e for e in self.api.draws[-1]['elements'] if e['id'].startswith('roll-rate')]
        self.assertEqual({e['id'] for e in rolls},{'roll-rate-input-2','roll-rate-output-2'})
        self.assertEqual({e['x'] for e in rolls},{40,56})
        self.assertFalse(self.motion.pending)

    def test_asset_retry_keeps_completed_uploads(self):
        from busybar_shared.api import ConnectionError
        original=self.api.upload_asset
        calls=[]
        def upload(name,data):
            calls.append(name)
            if len(calls)==2:raise ConnectionError('unavailable')
            original(name,data)
        self.api.upload_asset=upload
        with self.assertRaises(ConnectionError):self.show('working')
        completed=self.api.uploads[0]
        self.show('working')
        self.assertEqual(calls.count(completed),1)

    def test_expired_display_lease_reenters_with_a_full_view_fade(self):
        self.show('waiting');self.now[0]+=16
        self.show('working')
        ids={e['id'] for e in self.api.draws[-1]['elements']}
        self.assertTrue({'front','back','thinking','motion-view'}<=ids)
        self.assertFalse(self.motion.pending)

    def test_rpc_time_is_not_added_again_to_fade_out_duration(self):
        self.show('working')
        original=self.api.draw
        def slow_draw(payload):
            self.now[0]+=.4;return original(payload)
        self.api.draw=slow_draw
        self.show('waiting')
        self.assertTrue(self.motion.due)
        self.motion.advance()
        self.assertEqual(self.motion.current.state,'waiting')

    def test_overlay_reentry_resets_all_interrupted_region_masks(self):
        self.show('working');self.show('waiting')
        self.motion.invalidate()
        self.show('working')
        ids={e['id'] for e in self.api.draws[-1]['elements']}
        self.assertTrue({'motion-view','motion-bar','motion-icon','motion-rate'}<=ids)
