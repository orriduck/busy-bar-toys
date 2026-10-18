"""Three recognized client sessions, keyed by launch identity, never PID alone."""
import copy
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
from busybar_shared.cloud import atomic_json
from . import GAMES


def match_game(app):
    path = app.get('bundle')
    if not isinstance(path, str) or len(path) > 4096:
        return None
    path = str(PurePosixPath(path))
    return next((game.source for game in GAMES if app.get('bundleId') == game.bundle_id
                 and path.endswith(game.path_suffix)), None)


def number(value):
    try:
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError('invalid_game_snapshot')
    except OverflowError:
        raise ValueError('invalid_game_snapshot') from None
    return value


class GameSessions:
    def __init__(self, path):
        self.path = Path(path)
        self.sessions = {}
        self.boot = None
        self.continuous = 0
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            return
        try:
            if len(raw) > 16384: raise ValueError()
            saved = json.loads(raw)
            if not isinstance(saved, dict) or not isinstance(saved.get('boot'), str): raise ValueError()
            sessions = saved['sessions']
            if not isinstance(sessions, dict) or set(sessions)-{g.source for g in GAMES}: raise ValueError()
            for record in sessions.values():
                if not isinstance(record, dict) or not isinstance(record['id'], str) or len(record['id']) != 32: raise ValueError()
                number(record['elapsed']); number(record['startedAt'])
                members = record['members']
                if not isinstance(members, list) or not 1 <= len(members) <= 32: raise ValueError()
                for pid, start in members:
                    if type(pid) is not int or pid <= 0: raise ValueError()
                    number(start)
            self.boot, self.continuous, self.sessions = saved['boot'], number(saved['continuous']), sessions
        except (ValueError, TypeError, KeyError, RecursionError):
            raise ValueError('game_state_unreadable') from None

    def ingest(self, snapshot):
        if not isinstance(snapshot, dict): raise ValueError('invalid_game_snapshot')
        boot, apps = snapshot.get('boot'), snapshot.get('apps')
        if not isinstance(boot, str) or not 1 <= len(boot) <= 128 or not isinstance(apps, list) or len(apps) > 128:
            raise ValueError('invalid_game_snapshot')
        continuous, wall = number(snapshot.get('continuous')), number(snapshot.get('wall'))
        if boot == self.boot and continuous < self.continuous: raise ValueError('invalid_game_snapshot')
        groups = {}
        for app in apps:
            if not isinstance(app, dict): raise ValueError('invalid_game_snapshot')
            source = match_game(app)
            if source is None: continue
            pid = app.get('pid')
            if type(pid) is not int or pid <= 0: raise ValueError('invalid_game_snapshot')
            launch = round(number(app.get('launchedAt')), 3)
            groups.setdefault(source, []).append([pid, launch])
            if len(groups[source]) > 32: raise ValueError('invalid_game_snapshot')
        result = {}
        for source, members in groups.items():
            members = sorted(members)
            previous = self.sessions.get(source)
            if boot == self.boot and previous and any(member in previous['members'] for member in members):
                record = copy.deepcopy(previous)
                record['elapsed'] += continuous-self.continuous
            else:
                start = min(member[1] for member in members)
                identity = json.dumps([boot, source, members], separators=(',', ':'))
                record = {'id':hashlib.sha256(identity.encode()).hexdigest()[:32],
                          'startedAt':start, 'elapsed':max(0, wall-start)}
            record['members'] = members
            result[source] = record
        # Save first. A failed write must not make a sample look committed.
        atomic_json(self.path, {'boot':boot,'continuous':continuous,'sessions':result})
        self.sessions, self.boot, self.continuous = result, boot, continuous

    def elapsed(self, source, continuous):
        return max(0, self.sessions[source]['elapsed'] + max(0, continuous-self.continuous))
