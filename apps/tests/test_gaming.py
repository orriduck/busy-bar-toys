import tempfile
import unittest
from pathlib import Path
try:
    from busybar_apps.gaming.sessions import GameSessions, match_game
except ImportError:
    GameSessions = None


def app(pid=1, launch=100, kind='wow'):
    paths={'wow':'/Games/_retail_/World of Warcraft.app',
           'wow-forever':'/Games/_classic_beta_/World of Warcraft Beta.app',
           'maplestory':'/Games/MapleStory.app'}
    return {'pid':pid,'launchedAt':launch,'bundle':paths[kind],
            'bundleId':'com.nexon.maplestoryna_exe' if kind=='maplestory' else 'com.blizzard.worldofwarcraft'}


def snapshot(apps, continuous=1000, wall=200, boot='boot-a'):
    return {'apps':apps,'continuous':continuous,'wall':wall,'boot':boot}


class GameSessionsTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(GameSessions, 'Game session detection is missing')
        root=tempfile.TemporaryDirectory();self.addCleanup(root.cleanup)
        self.path=Path(root.name)/'games.json';self.games=GameSessions(self.path)

    def test_same_bundle_id_uses_actual_client_path_and_ignores_launchers(self):
        self.assertEqual(match_game(app()),'wow')
        self.assertEqual(match_game(app(kind='wow-forever')),'wow-forever')
        self.assertEqual(match_game(app(kind='maplestory')),'maplestory')
        for path in ['/Applications/Battle.net.app','/Games/_retail_/World of Warcraft.app/Contents/Helpers/WowVoiceProxy.app',
                     '/Games/World of Warcraft Launcher.app','/Games/MapleStory Launcher.app']:
            self.assertIsNone(match_game({**app(),'bundle':path}))

    def test_launch_uses_real_start_and_background_open_time_keeps_same_session(self):
        self.games.ingest(snapshot([app()]))
        first=self.games.sessions['wow']['id']
        self.assertEqual(self.games.elapsed('wow',1000),100)
        self.games.ingest(snapshot([app()],continuous=1002,wall=202))
        self.assertEqual(self.games.sessions['wow']['id'],first)
        self.assertEqual(self.games.elapsed('wow',1003),103)

    def test_exit_reopen_and_pid_reuse_create_new_session(self):
        self.games.ingest(snapshot([app()]))
        first=self.games.sessions['wow']['id']
        self.games.ingest(snapshot([],1002,202))
        self.assertNotIn('wow',self.games.sessions)
        self.games.ingest(snapshot([app(launch=204)],1004,204))
        self.assertNotEqual(self.games.sessions['wow']['id'],first)
        self.assertEqual(self.games.elapsed('wow',1004),0)
        second=self.games.sessions['wow']['id']
        self.games.ingest(snapshot([app(launch=205)],1005,205))
        self.assertNotEqual(self.games.sessions['wow']['id'],second)

    def test_multiple_clients_do_not_reset_while_an_overlapping_client_is_live(self):
        self.games.ingest(snapshot([app(),app(2,150),app(3,160,'maplestory')]))
        first=self.games.sessions['wow']['id']
        self.games.ingest(snapshot([app(2,150),app(3,160,'maplestory')],1002,202))
        self.assertEqual(self.games.sessions['wow']['id'],first)
        self.assertEqual(set(self.games.sessions),{'wow','maplestory'})
        self.assertEqual(self.games.elapsed('wow',1002),102)

    def test_collector_restart_and_sleep_use_continuous_clock_not_wall_clock(self):
        self.games.ingest(snapshot([app()]))
        first=self.games.sessions['wow']['id']
        restarted=GameSessions(self.path)
        restarted.ingest(snapshot([app()],continuous=4600,wall=50))
        self.assertEqual(restarted.sessions['wow']['id'],first)
        self.assertEqual(restarted.elapsed('wow',4600),3700)
        restarted.ingest(snapshot([app()],continuous=4602,wall=90000))
        self.assertEqual(restarted.elapsed('wow',4602),3702)

    def test_new_boot_does_not_reuse_pid_or_elapsed_time(self):
        self.games.ingest(snapshot([app()]))
        first=self.games.sessions['wow']['id']
        self.games.ingest(snapshot([app(launch=300)],10,300,'boot-b'))
        self.assertNotEqual(self.games.sessions['wow']['id'],first)
        self.assertEqual(self.games.elapsed('wow',10),0)

    def test_invalid_or_unknown_snapshot_does_not_fake_an_exit(self):
        self.games.ingest(snapshot([app()]))
        before=self.path.read_bytes()
        for bad in [None,[],{'apps':[]},snapshot([app()],float('nan')),snapshot([app()],999),
                    snapshot([{**app(),'pid':True}]),snapshot([{**app(),'launchedAt':None}])]:
            with self.subTest(value=bad):
                with self.assertRaises(ValueError):self.games.ingest(bad)
                self.assertEqual(self.path.read_bytes(),before)
                self.assertIn('wow',self.games.sessions)
