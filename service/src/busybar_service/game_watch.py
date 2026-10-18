"""Observe known game clients; cloud scheduling remains the only display arbiter."""
import copy
import logging
import time
from busybar_shared.activity import ActivityPublisher
from busybar_shared.cloud import CloudError
from busybar_shared.running_apps import RunningApps
from busybar_apps.gaming import GAMES
from busybar_apps.gaming.sessions import GameSessions
from busybar_apps.gaming.display import notification, time_element, elapsed_text
from .cloud_adapter import Capture, notification_scene

LOG = logging.getLogger('busy-bar')


class GameRenderer:
    def __init__(self, producer, game, *, reduced=False):
        self.producer, self.game, self.reduced = producer, game, reduced
        self.activity = ActivityPublisher(producer,'game',withdraw=True)
        self._scene = None
        self._last = None
        # A saved outbox alone is not evidence that the client is still open.
        self.activity.unknown()

    def show(self, session, elapsed):
        timer = Capture(self.producer).convert([time_element(self.game,elapsed)])[0]
        signature = (session, timer['text'])
        if signature == self._last:
            self.activity.renew()
            return
        if self.activity.identity != session: self._scene = None
        self.activity.begin(session)
        if self._scene is None:
            self._scene = notification_scene(self.producer,notification(self.game),reduced=self.reduced)
        scene = copy.deepcopy(self._scene)
        # Time is present from the first frame, independent of the title roll.
        scene['commands'][0]['elements'].append(timer)
        self.activity.publish({'app':self.game.source,'kind':'condition','level':'info','exit':'source',
            'title':self.game.title,'detail':'Open for '+elapsed_text(elapsed),
            'scene':scene,'actionKeys':[],'frameSignature':timer['text']}, [timer])
        self._last = signature

    def unknown(self):
        self._scene = None
        self._last = None
        self.activity.unknown()

    def hide(self):
        self._scene = None
        self._last = None
        self.activity.hide()


class GameWatch:
    def __init__(self, runtime, clients, routes, *, monitor=None, clock=time.monotonic, reduced=False):
        self.clock = clock
        by_id = {client.config['serviceId']:client for client in clients.values()}
        self.renderers = {}
        for game in GAMES:
            client = by_id.get(routes.get(game.source))
            if client and client.config.get('template') == 'custom':
                self.renderers[game.source] = GameRenderer(client,game,reduced=reduced)
        self.enabled = bool(self.renderers)
        self.sessions = GameSessions(runtime/'game-sessions.json') if self.enabled else None
        self.monitor = monitor or RunningApps({game.bundle_id for game in GAMES})
        self._sequence = None
        self._next = 0
        self._status = 'starting' if self.enabled else 'not-configured'

    def start(self):
        if self.enabled: self.monitor.start()

    def stop(self):
        if self.enabled: self.monitor.stop()

    def tick(self):
        if not self.enabled: return
        now = self.clock()
        if now < self._next: return
        self._next = now+1
        sample = self.monitor.latest()
        try:
            if sample is None or now-sample[1] > 6 or now < sample[1] or sample[2] is None:
                raise ValueError('app_sample_unavailable')
            sequence, observed, snapshot = sample
            if sequence != self._sequence:
                self.sessions.ingest(snapshot)
                self._sequence = sequence
            continuous = self.sessions.continuous+max(0,now-observed)
            partial = False
            for source, renderer in self.renderers.items():
                try:
                    session = self.sessions.sessions.get(source)
                    if session: renderer.show(session['id'],self.sessions.elapsed(source,continuous))
                    else: renderer.hide()
                except (CloudError, ValueError, OSError):
                    renderer.unknown()
                    partial = True
            self._status = 'partial' if partial else 'ready'
        except (ValueError, OSError):
            for renderer in self.renderers.values(): renderer.unknown()
            self._status = 'unknown'

    def diagnostics(self):
        return {'status':self._status, 'services':list(self.renderers),
                'running':list(self.sessions.sessions) if self.sessions and self._status=='ready' else []}
