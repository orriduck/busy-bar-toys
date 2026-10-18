import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from busybar_shared.cloud import Producer
from busybar_apps.gaming import GAMES
try:
    from busybar_service.game_watch import GameRenderer, GameWatch
except ImportError:
    GameRenderer = None


class HTTP:
    def request(self,*args):return {}


class GameWatchTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(GameRenderer,'Game publication is missing')
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        self.root=Path(folder.name);self.now=100
        self.producer=Producer(self.root,{'role':'wow','serviceId':'wow-id','instanceId':'mac','epoch':'e',
            'computerId':'pc','template':'custom'},HTTP(),clock=lambda:self.now)

    def test_elapsed_updates_only_timer_and_keep_native_entrance_and_occurrence(self):
        renderer=GameRenderer(self.producer,GAMES[0])
        renderer.show('session',59)
        first=self.producer.state.records['game'].copy()
        self.producer.state.records['game']['acked']=first['version']
        self.now=101;renderer.show('session',60)
        record=self.producer.state.records['game']
        self.assertEqual(record['itemId'],first['itemId'])
        self.assertEqual(record['kind'],'condition');self.assertEqual(record['exit'],'source')
        self.assertEqual([e['id'] for e in record['update']],['notice-detail'])
        self.assertEqual(record['update'][0]['text'],'01:00')
        self.assertEqual(record['scene']['entryDurationMs'],first['scene']['entryDurationMs'])
        first_animations=[e for c in first['scene']['commands'] for e in c['elements'] if e['type']=='animation']
        next_animations=[e for c in record['scene']['commands'] for e in c['elements'] if e['type']=='animation']
        self.assertEqual(first_animations,next_animations)
        self.assertTrue(any(e.get('text')=='00:59' for e in first['scene']['commands'][0]['elements']))
        renderer.hide()
        self.assertTrue(self.producer.state.data['ends'][first['itemId']]['withdraw'])

    def test_unknown_stale_exit_and_reopen_are_independent_of_cloud_selection(self):
        mono=[10.0];monitor=Mock();monitor.latest.return_value=None
        watch=GameWatch(self.root,{'wow':self.producer},{'wow':'wow-id'},monitor=monitor,clock=lambda:mono[0],reduced=True)
        snap={'boot':'boot','continuous':1000,'wall':200,'apps':[{'pid':1,'launchedAt':100,
            'bundleId':'com.blizzard.worldofwarcraft','bundle':'/Game/_retail_/World of Warcraft.app'}]}
        monitor.latest.return_value=(1,10,snap);watch.tick()
        first=self.producer.state.records['game']['itemId']
        mono[0]=11;watch.tick();self.assertEqual(self.producer.state.records['game']['detail'],'Open for 01:41')
        mono[0]=12;monitor.latest.return_value=(2,12,None);watch.tick()
        self.assertTrue(self.producer.state.records['game']['sourceUnknown'])
        self.assertFalse(self.producer.state.records['game'].get('cleared'))
        mono[0]=13;monitor.latest.return_value=(3,13,{**snap,'continuous':1003});watch.tick()
        self.assertFalse(self.producer.state.records['game']['sourceUnknown'])
        self.assertEqual(self.producer.state.records['game']['itemId'],first)
        mono[0]=20;watch.tick();self.assertTrue(self.producer.state.records['game']['sourceUnknown'])
        mono[0]=21;monitor.latest.return_value=(4,21,{**snap,'continuous':1011,'apps':[]});watch.tick()
        self.assertTrue(self.producer.state.records['game']['cleared'])
        mono[0]=22;monitor.latest.return_value=(5,22,{**snap,'continuous':1012,'wall':212,
            'apps':[{**snap['apps'][0],'launchedAt':212}]});watch.tick()
        self.assertNotEqual(self.producer.state.records['game']['itemId'],first)

    def test_no_implicit_service_or_agent_route_fallback(self):
        monitor=Mock()
        watch=GameWatch(self.root,{'wow':self.producer},{},monitor=monitor)
        self.assertFalse(watch.enabled)
        watch.start();monitor.start.assert_not_called()
        self.assertEqual(self.producer.state.records,{})

    def test_reopen_rebuilds_assets_evicted_after_the_old_session_ended(self):
        renderer=GameRenderer(self.producer,GAMES[0])
        renderer.show('first',10);renderer.hide()
        self.producer.state.data['assets'].clear()
        self.producer._assets.clear()
        renderer.show('second',0)
        scene=self.producer.state.records['game']['scene']
        hashes={e['assetHash'] for command in scene['commands'] for e in command['elements'] if 'assetHash' in e}
        self.assertTrue(hashes)
        self.assertTrue(hashes <= set(self.producer.state.data['assets']))

    def test_render_failure_marks_game_unknown_without_crashing_the_observer(self):
        from unittest.mock import patch
        from busybar_shared.cloud import CloudError
        mono=[10.0];monitor=Mock()
        snap={'boot':'boot','continuous':1000,'wall':200,'apps':[{'pid':1,'launchedAt':100,
            'bundleId':'com.blizzard.worldofwarcraft','bundle':'/Game/_retail_/World of Warcraft.app'}]}
        monitor.latest.return_value=(1,10,snap)
        watch=GameWatch(self.root,{'wow':self.producer},{'wow':'wow-id'},monitor=monitor,clock=lambda:mono[0])
        watch.tick()
        mono[0]=11
        with patch.object(watch.renderers['wow'],'show',side_effect=CloudError('local_asset_capacity')):
            watch.tick()
        self.assertTrue(self.producer.state.records['game']['sourceUnknown'])
        self.assertEqual(watch.diagnostics()['status'],'partial')

    def test_game_setup_uses_three_owned_custom_routes_without_rekeying_the_computer(self):
        from busybar_service.gaming_commands import setup_games
        from unittest.mock import patch
        config={'services':{g.source:{'serviceId':'id-'+g.source} for g in GAMES}}
        with patch('busybar_service.gaming_commands.load_computer',return_value=config), \
             patch('busybar_service.gaming_commands.subprocess.run') as build, \
             patch('busybar_service.gaming_commands.register_service',return_value=config) as register:
            self.assertEqual(setup_games(self.root,self.root),0)
        self.assertEqual(register.call_count,3)
        self.assertEqual({call.args[1] for call in register.call_args_list},{g.source for g in GAMES})
        self.assertTrue(all(call.kwargs['priority_group']=='dispensable' and call.kwargs['template']=='custom'
                            for call in register.call_args_list))
        build.assert_called_once()

    def test_saved_pending_game_is_not_published_before_a_fresh_native_sample(self):
        renderer=GameRenderer(self.producer,GAMES[0],reduced=True)
        renderer.show('session',1)
        self.producer.http.request=Mock(return_value={})
        restarted=GameRenderer(self.producer,GAMES[0],reduced=True)
        self.producer.flush()
        self.assertFalse(any(call.args[1]=='/api/publish' for call in self.producer.http.request.call_args_list))
        restarted.show('session',2)
        self.producer.flush()
        self.assertTrue(any(call.args[1]=='/api/publish' for call in self.producer.http.request.call_args_list))

    def test_timer_uses_the_cloud_element_contract_for_scene_and_deltas(self):
        renderer=GameRenderer(self.producer,GAMES[0],reduced=True)
        renderer.show('session',1)
        record=self.producer.state.records['game'];record['acked']=record['version']
        renderer.show('session',2)
        record=self.producer.state.records['game']
        elements=[e for c in record['scene']['commands'] for e in c['elements']]+record['update']
        forbidden={'timeout','display_until','application_name','path'}
        self.assertTrue(all(not forbidden.intersection(e) for e in elements),
                        'Native-only fields are rejected by the cloud ELEMENT_FIELD_NOT_ALLOWED contract')
